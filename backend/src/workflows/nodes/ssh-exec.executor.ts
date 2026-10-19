import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import { z } from 'zod';
import { SshService } from '../../ssh/ssh.service';
import { SshExecResult, SshSessionService } from '../../ssh/ssh-session.service';
import { SshTestService } from '../../ssh/ssh-test.service';
import { SshConnectionDocument } from '../../ssh/schemas/ssh-connection.schema';
import { WorkflowScopeGuard } from '../workflow-scope.guard';
import { NodeExecutor, NodeExecutionContext, NodeResult } from '../engine/types';
import { NodeMetadata } from '../engine/node-metadata';
import { WorkflowScope } from '../schemas/workflow-definition.schema';
import { errorMessage } from '../workflow-narrow';
import { expandTemplate } from './template';
import { expandShellCommand } from './shell-template';

const configSchema = z.object({
  connectionId: z.string().min(1).describe('ref:ssh-connection'),
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600000).optional(),
  idleTimeoutMs: z.number().int().min(0).max(600000).optional(),
  failOnNonZeroExit: z.boolean().default(true),
});

/** Fehlermeldungen aus dem SSH-Stack können lang werden (Stacks, Banner). */
const MAX_ERROR_MESSAGE = 500;
const TEST_REASON = 'Befehl wird im Test nicht ausgeführt';

type AbortCode = 'timeout' | 'idle_timeout' | 'cancelled';

const ABORT_CODES: Record<NonNullable<SshExecResult['aborted']>, AbortCode> = {
  timeout: 'timeout',
  idle: 'idle_timeout',
  cancelled: 'cancelled',
};

interface RunOwner {
  projectId?: Types.ObjectId;
  customerId?: Types.ObjectId;
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

function templateUnresolved(missing: string[], invalid: string[]): NodeResult {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`fehlend: ${missing.join(', ')}`);
  if (invalid.length > 0) parts.push(`nicht darstellbar: ${invalid.join(', ')}`);
  return {
    status: 'failed',
    error: {
      code: 'template_unresolved',
      message: cap(`Platzhalter nicht auflösbar (${parts.join('; ')})`),
      details: { missing, invalid },
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
      '{{…}} im Befehl wird shell-sicher gequotet, {{{…}}} roh eingesetzt.',
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
    },
    branches: ['success', 'failure'],
  };

  constructor(
    private readonly ssh: SshService,
    private readonly session: SshSessionService,
    private readonly tester: SshTestService,
    private readonly scope: WorkflowScopeGuard,
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

    const expansion = expandShellCommand(config.command, ctx.runContext);
    if (!expansion.ok) return templateUnresolved(expansion.missing, expansion.invalid);

    if (ctx.signal.aborted) return this.cancelled();

    let result: SshExecResult;
    try {
      result = await this.session.exec(connectionId, expansion.command, {
        timeoutMs: config.timeoutMs,
        idleTimeoutMs: config.idleTimeoutMs,
        cwd: cwd?.value,
        userId: ctx.accountableUserId,
        sourceContext: 'workflow',
        workflow: {
          runId: ctx.run._id.toString(),
          nodeId: ctx.node.id,
          definitionId: ctx.run.definitionId.toString(),
        },
        signal: ctx.signal,
      });
    } catch (err: unknown) {
      // Ein Abbruch vor dem Senden kommt als Wurf zurück, nicht als `aborted`.
      if (ctx.signal.aborted) return this.cancelled();
      return this.sshError(err);
    }

    const aborted = result.aborted ? ABORT_CODES[result.aborted] : null;
    const output: Record<string, unknown> = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      truncated: result.truncated,
      aborted,
      connection: connection.label,
    };
    ctx.logger.info('ssh.exec beendet', {
      connection: connection.label,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      aborted,
    });

    // Ein Abbruch ist nie ein Erfolg — auch nicht mit failOnNonZeroExit:false,
    // der Befehl ist ja nicht zu Ende gelaufen.
    if (aborted) {
      return {
        status: 'failed',
        output,
        error: { code: aborted, message: `Befehl abgebrochen (${aborted})` },
      };
    }
    // `exitCode: null` ohne Abbruch heißt: per Signal beendet — ebenfalls kein 0.
    if (config.failOnNonZeroExit && result.exitCode !== 0) {
      const how = result.exitCode === null ? `Signal ${result.signal ?? 'unbekannt'}` : `Exit-Code ${result.exitCode}`;
      return {
        status: 'failed',
        output,
        error: { code: 'nonzero_exit', message: `Befehl endete mit ${how}` },
      };
    }
    return { status: 'success', output };
  }

  /**
   * Testmodus: prüft Konfiguration, Verbindung und Lauf-Scope und baut eine
   * Verbindung auf (`SshTestService`) — der Befehl selbst wird nie gesendet.
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
    const fail = (code: string, message: string) => ({ ok: false, ...base, error: { code, message: cap(message) } });

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

    try {
      const test = await this.tester.testConnection(connectionId, { userId });
      // Nur die Zusammenfassung — Fingerprints sind öffentlich, Zugangsdaten
      // tauchen im Testergebnis ohnehin nicht auf.
      return {
        ok: test.ok,
        ...base,
        connection: {
          label: connection.label,
          ok: test.ok,
          fingerprint: test.fingerprint,
          fingerprintAccepted: test.fingerprintAccepted,
          fingerprintMismatch: test.fingerprintMismatch,
          error: test.error ? { code: test.error.code, message: cap(test.error.message) } : undefined,
        },
      };
    } catch (err: unknown) {
      return fail('ssh_error', errorMessage(err));
    }
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
