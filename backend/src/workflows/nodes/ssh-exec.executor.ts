import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { z } from 'zod';
import { SshService } from '../../ssh/ssh.service';
import { DEFAULT_IDLE_TIMEOUT_MS, SshExecResult, SshSessionService } from '../../ssh/ssh-session.service';
import { SshTestService } from '../../ssh/ssh-test.service';
import { SshConnectionDocument } from '../../ssh/schemas/ssh-connection.schema';
import { WorkflowScopeGuard } from '../workflow-scope.guard';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { WORKFLOW_RUNTIME_LIMITS } from '../workflow-security.runtime';
import { errorMessage } from '../workflow-narrow';
import { expandTemplate } from './template';
import { endsInsideQuotes, expandShellCommand, shellQuote } from './shell-template';
import { SECRET_MASK, findSecretKeys, maskSecrets } from './template-resolver';
import { WorkflowSecretsResolver } from '../engine/workflow-secrets.resolver';
import { LineResult, ScriptAbort, ScriptLine, buildScript, lineFailureMessage, parseScriptOutput, splitCommandLines } from './ssh-script';

const configSchema = z.object({
  connectionId: z.string().min(1).describe('ref:ssh-connection'),
  // Mehrzeilig: jede Zeile läuft in derselben Shell, das Ergebnis kommt pro Zeile.
  command: z.string().min(1).describe('widget:shell'),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  idleTimeoutMs: z.number().int().min(0).max(600000).optional(),
  failOnNonZeroExit: z.boolean().default(true),
});

/** Fehlermeldungen aus dem SSH-Stack können lang werden (Stacks, Banner). */
const MAX_ERROR_MESSAGE = 500;
const TEST_REASON = 'Befehl wird im Test nicht ausgeführt';

const ABORT_CODES: Record<NonNullable<SshExecResult['aborted']>, ScriptAbort> = {
  timeout: 'timeout',
  idle: 'idle_timeout',
  cancelled: 'cancelled',
};

interface RunOwner {
  projectId?: Types.ObjectId;
  customerId?: Types.ObjectId;
}

/** Vorsprung des SSH-Timeouts vor dem Engine-Timeout (= SIGKILL-Gnadenfrist im SSH-Stack). */
const SSH_TIMEOUT_HEADROOM_MS = 5_000;
const MIN_SSH_TIMEOUT_MS = 1_000;

/**
 * SSH- und Idle-Timeout aus der Node-Konfiguration.
 *
 * Die Engine nimmt `config.timeoutMs` (sonst ihren Default) als Node-Timeout.
 * Bekäme SSH denselben Wert, feuerten beide gleichzeitig — die Engine gewänne
 * meist, weil SSH nach SIGTERM noch bis zu 5 s auf `close` wartet, und das
 * Ergebnis verlöre stdout/stderr. Deshalb läuft SSH 5 s früher ab und liefert
 * selbst `timeout` samt Ausgabe; das Engine-Timeout bleibt nur Rückfallebene.
 * Das Idle-Timeout darf nicht länger sein als das SSH-Timeout (0 = aus).
 * Ohne Angabe gilt der Leerlauf-Default des SSH-Stacks — hier aufgelöst statt
 * dort, damit die Meldung („30 s ohne Ausgabe") die tatsächliche Grenze nennt.
 */
export function sshTimeouts(config: { timeoutMs?: number; idleTimeoutMs?: number }): {
  timeoutMs: number;
  idleTimeoutMs: number;
} {
  const nodeTimeout = config.timeoutMs ?? WORKFLOW_RUNTIME_LIMITS.defaultNodeTimeoutMs;
  const timeoutMs = Math.max(MIN_SSH_TIMEOUT_MS, nodeTimeout - SSH_TIMEOUT_HEADROOM_MS);
  const idleTimeoutMs = Math.min(config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, timeoutMs);
  return { timeoutMs, idleTimeoutMs };
}

function cap(message: string): string {
  return message.length > MAX_ERROR_MESSAGE ? message.slice(0, MAX_ERROR_MESSAGE) : message;
}

/**
 * Expandiert ein Nicht-Befehls-Feld (connectionId, cwd) mit dem normalen
 * Template. `expandTemplate` lässt unbekannte Pfade literal stehen — für eine
 * Verbindungs-Id oder ein Arbeitsverzeichnis wäre das ein stiller Fehlgriff,
 * deshalb werden Reste als `missing` gemeldet.
 */
function expandField(value: string, context: Record<string, unknown>): { value: string; missing: string[] } {
  const expanded = expandTemplate(value, context);
  const missing = [...expanded.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1].trim());
  return { value: expanded, missing };
}

type CommandPlan =
  | { ok: true; lines: ScriptLine[] }
  | { ok: false; result: NodeResult };

/**
 * Zerlegt den Befehl in Zeilen und setzt Platzhalter je Zeile ein. Je Zeile,
 * nicht im Ganzen: ein gequoteter Wert mit Zeilenumbruch bliebe sonst nicht
 * eine Zeile. Ein über das Zeilenende offener Quote wird abgelehnt — zwischen
 * den Zeilen stehen Marker-Befehle, die er sonst einschlösse (und ein dort
 * eingesetztes `'…'` stünde in Double-Quotes, `$(…)` im Wert liefe).
 */
function planCommand(command: string, context: Record<string, unknown>): CommandPlan {
  const lines = splitCommandLines(command);
  if (lines.length === 0) {
    return {
      ok: false,
      result: { status: 'failed', error: { code: 'invalid_config', message: 'Befehl enthält keine ausführbare Zeile' } },
    };
  }
  const open = lines.find((l) => endsInsideQuotes(l.command));
  if (open) {
    return {
      ok: false,
      result: {
        status: 'failed',
        error: {
          code: 'invalid_config',
          message:
            `Zeile ${open.line}: Anführungszeichen nicht geschlossen — jede Zeile läuft einzeln, ` +
            'mehrzeilige Strings sind nicht möglich (Zeilen mit \\ am Ende verbinden)',
        },
      },
    };
  }
  const missing = new Set<string>();
  const invalid = new Set<string>();
  const quoted = new Set<string>();
  const expanded: ScriptLine[] = [];
  for (const l of lines) {
    const e = expandShellCommand(l.command, context);
    if (e.ok) {
      expanded.push({ line: l.line, command: e.command });
    } else {
      e.missing.forEach((p) => missing.add(p));
      e.invalid.forEach((p) => invalid.add(p));
      e.quoted.forEach((p) => quoted.add(p));
    }
  }
  if (missing.size > 0 || invalid.size > 0) {
    return { ok: false, result: templateUnresolved([...missing], [...invalid], [...quoted]) };
  }
  return { ok: true, lines: expanded };
}

/**
 * Zu maskierende Formen der Secret-Werte: roh **und** shell-gequotet, so wie
 * `{{secrets.X}}` gesendet wird (aus `a'b` wird `'a'\''b'`, das den Rohwert
 * nicht mehr am Stück enthält — die Engine-Maskierung fände ihn nicht).
 */
function secretForms(secretValues: string[]): string[] {
  return [...secretValues, ...secretValues.map((v) => shellQuote(v))];
}

function templateUnresolved(missing: string[], invalid: string[], quoted: string[] = []): NodeResult {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`fehlend: ${missing.join(', ')}`);
  // Pfade in Quotes stehen auch in `invalid`; dort nur die übrigen nennen,
  // damit der Grund nicht doppelt und missverständlich erscheint.
  const unrenderable = invalid.filter((p) => !quoted.includes(p));
  if (unrenderable.length > 0) parts.push(`nicht darstellbar: ${unrenderable.join(', ')}`);
  if (quoted.length > 0) {
    parts.push(
      `Platzhalter in Anführungszeichen: ${quoted.join(', ')} — Platzhalter ohne Anführungszeichen schreiben, ` +
        '{{…}} wird automatisch shell-sicher gequotet',
    );
  }
  return {
    status: 'failed',
    error: {
      code: 'template_unresolved',
      message: cap(`Platzhalter nicht auflösbar (${parts.join('; ')})`),
      details: { missing, invalid, quoted },
    },
  };
}

/**
 * Führt einen Befehl auf einer gespeicherten SSH-Verbindung aus.
 *
 * Reihenfolge ist Absicht: erst laden (prüft den Akteur-Zugriff), dann den
 * Lauf-Scope, erst danach den Befehl bauen und senden. Jede Ablehnung endet
 * vor `exec` — ein abgelehnter Lauf hat den Server nie berührt.
 */
@Injectable()
export class SshExecExecutor implements NodeExecutor {
  readonly type = 'ssh.exec';
  readonly metadata: NodeMetadata = {
    type: 'ssh.exec',
    category: 'action',
    label: 'SSH-Befehl',
    description:
      'Führt einen Befehl auf einer SSH-Verbindung des Projekts/Kunden aus. ' +
      'Mehrere Zeilen laufen nacheinander in derselben Shell, das Ergebnis kommt pro Zeile (lines). ' +
      '{{…}} im Befehl wird shell-sicher gequotet, {{{…}}} roh eingesetzt. ' +
      'Platzhalter nie selbst in Anführungszeichen setzen — das wird abgelehnt.',
    allowedScopes: [WorkflowScope.PROJECT, WorkflowScope.CUSTOMER],
    configSchema,
    outputs: {
      exitCode: 'number|null',
      stdout: 'string',
      stderr: 'string',
      durationMs: 'number',
      truncated: 'object',
      aborted: 'string|null',
      connection: 'string',
      lines: 'array',
    },
    branches: ['success', 'failure'],
    // Einziger Node-Typ mit echten Secret-Werten: der Befehl geht an den
    // Server, Ausgabe/Logs/Fehler maskiert die Engine danach wieder.
    secretPlaceholders: true,
  };

  constructor(
    private readonly ssh: SshService,
    private readonly session: SshSessionService,
    private readonly tester: SshTestService,
    private readonly scope: WorkflowScopeGuard,
    private readonly secretsResolver: WorkflowSecretsResolver,
  ) {}

  async execute(ctx: NodeExecutionContext): Promise<NodeResult> {
    // Die Engine reicht die gespeicherte Konfiguration ungeparst weiter; hier
    // wird sie geprüft, damit z. B. ein zu großes timeoutMs nicht erst im
    // SSH-Stack still geklemmt wird und `failOnNonZeroExit` seinen Default hat.
    const parsed = configSchema.safeParse(ctx.config);
    if (!parsed.success) {
      return {
        status: 'failed',
        error: {
          code: 'invalid_config',
          message: cap(parsed.error.issues.map((i) => `config.${i.path.join('.')}: ${i.message}`).join('; ')),
        },
      };
    }
    const config = parsed.data;

    const conn = expandField(config.connectionId, ctx.runContext);
    const cwd = config.cwd !== undefined ? expandField(config.cwd, ctx.runContext) : undefined;
    const fieldMissing = [...conn.missing, ...(cwd?.missing ?? [])];
    if (fieldMissing.length > 0) return templateUnresolved(fieldMissing, []);
    const connectionId = conn.value.trim();
    // sshd reicht den Befehl als C-String weiter; ein NUL im cwd schnitte das
    // `cd '…' &&` mitten im Quote ab.
    if (cwd?.value.includes('\0')) {
      return { status: 'failed', error: { code: 'invalid_config', message: 'cwd enthält ein NUL-Byte' } };
    }

    if (ctx.signal.aborted) return this.cancelled();

    let connection: SshConnectionDocument;
    try {
      connection = await this.ssh.findById(connectionId);
    } catch (err: unknown) {
      return this.sshError(err);
    }
    if (!(await this.scope.check(ctx.run, connection))) {
      return this.scope.deny(ctx.run, ctx.node.id, { type: 'ssh-connection', id: connectionId });
    }

    const plan = planCommand(config.command, ctx.runContext);
    if (!plan.ok) return plan.result;

    if (ctx.signal.aborted) return this.cancelled();

    const nonce = randomBytes(6).toString('hex');
    const failFast = config.failOnNonZeroExit;
    // Das Arbeitsverzeichnis gehört ins Skript statt in `opts.cwd`: der
    // SSH-Stack setzt `cd … && <befehl>` davor, und das `&&` bände nur die
    // erste Skriptzeile — nach einem gescheiterten `cd` liefen die übrigen
    // Zeilen im falschen Verzeichnis.
    const prefix = cwd !== undefined ? `cd -- ${shellQuote(cwd.value)} || exit $?\n` : '';
    const script = prefix + buildScript(plan.lines, { nonce, failFast });
    const timeouts = sshTimeouts(config);
    const forms = secretForms(ctx.secretValues ?? []);

    let result: SshExecResult;
    try {
      result = await this.session.exec(connectionId, script, {
        timeoutMs: timeouts.timeoutMs,
        idleTimeoutMs: timeouts.idleTimeoutMs,
        userId: ctx.accountableUserId,
        sourceContext: 'workflow',
        workflow: {
          runId: ctx.run._id.toString(),
          nodeId: ctx.node.id,
          definitionId: ctx.run.definitionId.toString(),
          // Debug-Läufe gibt es erst mit `run.mode` (Task 6).
          debug: false,
        },
        // Ins Audit: eingesetzter Befehl ohne Marker, Secrets maskiert.
        auditCommand: maskSecrets(plan.lines.map((l) => l.command).join('\n'), forms),
        signal: ctx.signal,
      });
    } catch (err: unknown) {
      // Ein Abbruch vor dem Senden kommt als Wurf zurück, nicht als `aborted`.
      if (ctx.signal.aborted) return this.cancelled();
      return this.sshError(err);
    }

    const aborted = result.aborted ? ABORT_CODES[result.aborted] : null;
    const ran = parseScriptOutput(
      plan.lines,
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(aborted ? { aborted } : {}) },
      nonce,
    );
    const output: Record<string, unknown> = {
      exitCode: ran.lastExitCode,
      stdout: ran.stdout,
      stderr: ran.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      aborted,
      connection: connection.label,
      // Die Zeilen tragen den eingesetzten Befehl — auch hier die gequotete
      // Secret-Form maskieren, die Engine kennt nur die Rohwerte.
      lines: ran.lines.map((l) => ({ ...l, command: maskSecrets(l.command, forms) })),
    };
    ctx.logger.info('ssh.exec beendet', {
      connection: connection.label,
      exitCode: ran.lastExitCode,
      lines: `${ran.lines.length}/${plan.lines.length}`,
      durationMs: result.durationMs,
      aborted,
    });

    // Ein Abbruch ist nie ein Erfolg — auch nicht mit failOnNonZeroExit:false,
    // der Befehl ist ja nicht zu Ende gelaufen.
    if (aborted) {
      const line = ran.lines.find((l) => l.aborted !== undefined);
      return {
        status: 'failed',
        output,
        error: { code: aborted, message: line ? lineFailureMessage(line, timeouts) : `Befehl abgebrochen (${aborted})` },
      };
    }
    // `exitCode: null` ohne Abbruch heißt: per Signal beendet — ebenfalls kein 0.
    if (config.failOnNonZeroExit && ran.lastExitCode !== 0) {
      const line: LineResult | undefined = ran.lines.find((l) => l.exitCode !== 0);
      const how =
        ran.lastExitCode === null ? `Signal ${result.signal ?? 'unbekannt'}` : `Exit-Code ${ran.lastExitCode}`;
      return {
        status: 'failed',
        output,
        error: { code: 'nonzero_exit', message: line ? lineFailureMessage(line, timeouts) : `Befehl endete mit ${how}` },
      };
    }
    return { status: 'success', output };
  }

  /**
   * Testmodus: prüft Konfiguration, Verbindung und Lauf-Scope und baut eine
   * Verbindung auf (`SshTestService`) — der Befehl selbst wird nie gesendet.
   * Sind alle Platzhalter auflösbar, kommen die eingesetzten Zeilen als
   * `commands` mit; sonst nennt `commandProblem` den Grund.
   */
  async connectionCheck(
    owner: RunOwner,
    rawConfig: Record<string, unknown>,
    runContext: Record<string, unknown>,
    userId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const base = {
      executable: false,
      mode: 'connection_check',
      reason: TEST_REASON,
      outputSchema: this.metadata.outputs,
      branches: this.metadata.branches,
    };
    // Der Test-Dialog (`TestResultView`) zeigt nur `outputPreview`/`errorPreview`
    // — ohne diese Schlüssel sah der Nutzer bei einem Fehlschlag keinen Grund.
    // `error`/`connection` bleiben für MCP-Aufrufer erhalten.
    const fail = (code: string, message: string) => {
      const error = { code, message: cap(message) };
      return { ok: false, ...base, error, errorPreview: error };
    };

    const parsed = configSchema.safeParse(rawConfig);
    if (!parsed.success) return fail('invalid_config', parsed.error.issues.map((i) => i.message).join('; '));
    const conn = expandField(parsed.data.connectionId, runContext);
    if (conn.missing.length > 0) {
      return fail('template_unresolved', `Platzhalter nicht auflösbar (fehlend: ${conn.missing.join(', ')})`);
    }
    const connectionId = conn.value.trim();

    let connection: SshConnectionDocument;
    try {
      connection = await this.ssh.findById(connectionId);
    } catch (err: unknown) {
      return fail('ssh_error', errorMessage(err));
    }
    if (!(await this.scope.check(owner, connection))) {
      return fail('scope_violation', 'ssh-connection liegt außerhalb des Scopes dieses Workflows');
    }

    const preview = await this.previewCommands(owner, parsed.data.command, runContext);

    try {
      const test = await this.tester.testConnection(connectionId, { userId });
      // Nur die Zusammenfassung — Fingerprints sind öffentlich, Zugangsdaten
      // tauchen im Testergebnis ohnehin nicht auf.
      const error = test.error ? { code: test.error.code, message: cap(test.error.message) } : undefined;
      const summary = {
        label: connection.label,
        ok: test.ok,
        fingerprint: test.fingerprint,
        fingerprintAccepted: test.fingerprintAccepted,
        fingerprintMismatch: test.fingerprintMismatch,
        error,
      };
      return {
        ok: test.ok,
        ...base,
        connection: summary,
        ...preview,
        outputPreview: { ...summary, ...preview },
        ...(error ? { errorPreview: error } : {}),
      };
    } catch (err: unknown) {
      return fail('ssh_error', errorMessage(err));
    }
  }

  /**
   * Eingesetzte Zeilen für den Test, ohne je ein Secret zu entschlüsseln.
   * Ein vom Aufrufer mitgeschicktes `runContext.secrets` zählt nicht — es
   * käme aus dem Request, nicht aus der Secret-Ablage. Für `{{secrets.KEY}}`
   * reicht, dass der KEY für den Workflow verfügbar ist; im Ergebnis steht
   * `••••(KEY)`. Nicht verfügbare KEYs sind `missing` wie jeder andere Pfad.
   */
  private async previewCommands(
    owner: RunOwner,
    command: string,
    runContext: Record<string, unknown>,
  ): Promise<{ commands: ScriptLine[] } | { commandProblem: { code: string; message: string } }> {
    const context: Record<string, unknown> = { ...runContext };
    delete context.secrets;
    // Platzhalterwerte, die nach dem Einsetzen gegen ••••(KEY) getauscht
    // werden. Hex-Nonce + Index: keine Quotes, also gequotet einfach `'…'`.
    const display = new Map<string, string>();
    const keys = findSecretKeys(command);
    if (keys.length > 0) {
      let available: Set<string>;
      try {
        const infos = await this.secretsResolver.available({
          projectId: owner.projectId?.toString(),
          customerId: owner.customerId?.toString(),
        });
        available = new Set(infos.map((s) => s.key));
      } catch (err: unknown) {
        return { commandProblem: { code: 'secrets_unavailable', message: cap(errorMessage(err)) } };
      }
      const nonce = randomBytes(6).toString('hex');
      const secrets: Record<string, string> = {};
      keys.forEach((key, i) => {
        if (!available.has(key)) return;
        const token = `__DG_SECRET_${nonce}_${i}__`;
        secrets[key] = token;
        display.set(token, `${SECRET_MASK}(${key})`);
      });
      context.secrets = secrets;
    }
    const plan = planCommand(command, context);
    if (!plan.ok) {
      const error = plan.result.error ?? { code: 'invalid_config', message: 'Befehl ungültig' };
      return { commandProblem: { code: error.code, message: error.message } };
    }
    const toDisplay = (text: string): string => {
      let out = text;
      for (const [token, shown] of display) {
        out = out.split(shellQuote(token)).join(shown).split(token).join(shown);
      }
      return out;
    };
    return { commands: plan.lines.map((l) => ({ line: l.line, command: toDisplay(l.command) })) };
  }

  private cancelled(): NodeResult {
    return { status: 'failed', error: { code: 'cancelled', message: 'Node wurde abgebrochen, bevor der Befehl lief' } };
  }

  /**
   * Fehler aus dem SSH-Stack tragen Codes wie `credential_missing` oder
   * `host_key_mismatch` als Meldung; aufgelöste Zugangsdaten verlassen
   * `SshSessionService` nicht. Die Ursache (`cause`) wird bewusst nicht
   * übernommen, die Meldung gekappt.
   */
  private sshError(err: unknown): NodeResult {
    return { status: 'failed', error: { code: 'ssh_error', message: cap(errorMessage(err)) } };
  }
}
