/**
 * Anzeige-Helfer für Platzhalter-Spuren (Lauf-Inspektor, Debug-Panel).
 * Bewusst importfrei, damit `scripts/placeholder-view-check.cjs` die Datei
 * ohne Bundler übersetzen kann — daher stehen die Typen hier und
 * `api/workflows.ts` übernimmt sie von dort.
 */

export type PlaceholderStatus = 'resolved' | 'empty' | 'missing' | 'unknown' | 'secret' | 'secret_forbidden';

export interface PlaceholderTrace {
  /** Pfad in der Config, z.B. 'command', 'tags.0'. */
  field: string;
  /** 1-basierte Zeile innerhalb des String-Werts. */
  line: number;
  /** 'nodes.exec.stdout' | 'secrets.GIT_TOKEN' */
  expr: string;
  /** true bei `{{{…}}}`. */
  raw: boolean;
  status: PlaceholderStatus;
  /** Anzeige-Wert, max. 200 Zeichen, Secrets als ••••(KEY). */
  preview?: string;
}

export type PlaceholderTone = 'ok' | 'muted' | 'warn' | 'error';

/** `warn` ist für künftige Zwischenzustände reserviert; heute ist jeder Status ok, still oder Fehler. */
export function placeholderTone(status: PlaceholderStatus): PlaceholderTone {
  switch (status) {
    case 'resolved':
    case 'secret':
      return 'ok';
    case 'empty':
    case 'unknown':
      return 'muted';
    case 'missing':
    case 'secret_forbidden':
      return 'error';
  }
}

/** Spuren je Config-Feld, Felder in der Reihenfolge ihres ersten Auftretens. */
export function groupByField(traces: PlaceholderTrace[]): Array<{ field: string; traces: PlaceholderTrace[] }> {
  const groups = new Map<string, PlaceholderTrace[]>();
  for (const trace of traces) {
    const list = groups.get(trace.field);
    if (list) list.push(trace);
    else groups.set(trace.field, [trace]);
  }
  return Array.from(groups, ([field, list]) => ({ field, traces: list }));
}

const SECRET_REF = /\{\{\{?\s*secrets\.([A-Za-z0-9_.-]+?)\s*\}?\}\}/g;

/** Lokal statt aus `lib/narrow.ts`: die Datei bleibt importfrei (siehe oben). */
function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function collectSecretKeys(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(SECRET_REF)) into.add(m[1]);
  } else if (isUnknownArray(value)) {
    for (const v of value) collectSecretKeys(v, into);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectSecretKeys(v, into);
  }
}

/**
 * KEYs aller `{{secrets.KEY}}` in der Config eines Node-Typs ohne
 * `secretPlaceholders` — dort ist das ein Validierungsfehler
 * (`secret_not_allowed`), den der Editor schon vor dem Speichern zeigt.
 * `type` dient nur der Lesbarkeit am Aufrufer; entschieden wird über `allowed`.
 */
export function secretPlaceholderIssue(_type: string, allowed: boolean, config: unknown): string[] {
  if (allowed) return [];
  const keys = new Set<string>();
  collectSecretKeys(config, keys);
  return Array.from(keys);
}

/** Ergebnis einer Zeile von `ssh.exec` (`outputSnapshot.lines`). */
export interface LineResult {
  line: number;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  aborted?: 'timeout' | 'idle_timeout' | 'cancelled';
  /** stdout/stderr der Zeile auf die letzten Zeichen gekürzt (Gesamtausgabe bleibt vollständig). */
  truncated: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function toLineResult(v: unknown): LineResult | null {
  if (!isObject(v)) return null;
  const { line, command, exitCode, stdout, stderr, durationMs, aborted, truncated } = v;
  if (typeof line !== 'number' || typeof command !== 'string') return null;
  const result: LineResult = {
    line,
    command,
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: typeof stderr === 'string' ? stderr : '',
    durationMs: typeof durationMs === 'number' ? durationMs : null,
    truncated: truncated === true,
  };
  if (aborted === 'timeout' || aborted === 'idle_timeout' || aborted === 'cancelled') result.aborted = aborted;
  return result;
}

/**
 * `outputSnapshot.lines` als Zeilenergebnisse, sonst `null`. Ein Snapshot ist
 * ungeprüftes JSON; ein Eintrag, der keine Zeile ist, macht die ganze Liste
 * unbrauchbar (lieber JSON zeigen als eine halbe Tabelle).
 */
export function readLines(output: unknown): LineResult[] | null {
  if (!isObject(output)) return null;
  const raw: unknown = output.lines;
  if (!Array.isArray(raw)) return null;
  const entries: unknown[] = raw;
  const lines: LineResult[] = [];
  for (const entry of entries) {
    const parsed = toLineResult(entry);
    if (!parsed) return null;
    lines.push(parsed);
  }
  return lines;
}

/**
 * Gekürzter Snapshot: `{ truncated: true, preview }` (engine/snapshot-cap.ts)
 * oder `{ redacted, truncated: true }` (workflow-redaction.ts `redactRecord`,
 * wenn die Struktur zu einem String zusammengefaltet wurde).
 */
export function isTruncatedSnapshot(value: unknown): boolean {
  if (!isObject(value) || value.truncated !== true) return false;
  return typeof value.preview === 'string' || 'redacted' in value;
}
