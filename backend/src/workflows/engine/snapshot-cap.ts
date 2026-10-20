import { isRecord } from '../../common/tool-args';
import { redactRecord } from '../workflow-redaction';

/**
 * Obergrenze für Snapshots im NodeRun (Eingang, eingesetzte Config). Ein Node,
 * der einen großen Vorgänger-Output bekommt, soll das NodeRun-Dokument nicht
 * aufblähen — die Debug-Ansicht braucht Anhaltspunkte, nicht das Volumen.
 */
export const SNAPSHOT_MAX_CHARS = 20_000;

/**
 * Redaction-Grenzen für Snapshots: bewusst so weit, dass `capSnapshot` die
 * einzige Größenbegrenzung ist. Mit den Defaults von `redactRecord` (4096
 * Zeichen, Tiefe 6, Strings 500) wurde jeder größere Eingang schon dort zu
 * `{ redacted, truncated }` und die 20 000er-Grenze war toter Code.
 */
export const SNAPSHOT_REDACT_OPTIONS = {
  maxChars: SNAPSHOT_MAX_CHARS,
  maxDepth: 12,
  maxStringLength: 4_000,
} as const;

/**
 * Gibt das Objekt unverändert zurück, solange seine JSON-Form in die Grenze
 * passt; sonst nur den Anfang als `preview` samt `truncated`-Markierung.
 */
export function capSnapshot(value: unknown, maxChars: number = SNAPSHOT_MAX_CHARS): Record<string, unknown> {
  const json = JSON.stringify(value) ?? '';
  if (json.length <= maxChars && isRecord(value)) return value;
  return { truncated: true, preview: json.slice(0, maxChars) };
}

/** Stufen für die Länge einzelner Strings, bis die Struktur in die Grenze passt. */
const STRING_LIMIT_STEPS = [SNAPSHOT_REDACT_OPTIONS.maxStringLength, 1_000, 200];

/**
 * Redaction für Node-Ausgaben (`outputSnapshot`, `run.context.nodes.<id>`).
 * Anders als `capSnapshot` bleibt die Struktur erhalten: ist das Objekt zu
 * groß, werden zuerst die Strings kürzer gekappt — `exitCode` & Co. bleiben
 * Felder, `{{nodes.X.exitCode}}` löst weiter auf. Erst wenn auch das nicht
 * reicht (sehr viele Felder), bleibt nur die Vorschau.
 */
export function structuredSnapshot(value: unknown, maxChars: number = SNAPSHOT_MAX_CHARS): Record<string, unknown> {
  for (const maxStringLength of STRING_LIMIT_STEPS) {
    // `maxChars` hier ohne Wirkung: die Grenze prüft die Schleife selbst,
    // sonst faltete `redact` die Struktur vorher zu einem String.
    const redacted = redactRecord(value, { ...SNAPSHOT_REDACT_OPTIONS, maxStringLength, maxChars: Number.MAX_SAFE_INTEGER });
    if ((JSON.stringify(redacted) ?? '').length <= maxChars) return redacted;
  }
  return capSnapshot(redactRecord(value, SNAPSHOT_REDACT_OPTIONS), maxChars);
}

/** Was ein Node vom Lauf sieht: nur `input`, `incoming`, `nodes` — nichts Internes (z.B. `fromEdges`). */
export function inputView(runContext: Record<string, unknown>): Record<string, unknown> {
  return { input: runContext.input, incoming: runContext.incoming, nodes: runContext.nodes };
}
