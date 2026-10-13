import { redact, redactValue } from '../workflows/workflow-redaction';
import { ChatToolCallRecord } from './schemas/chat-session.schema';

/** Wie die Live-Kürzung im Controller — persistiert wird nicht mehr als das. */
export const MAX_PERSISTED_TOOL_CHARS = 8000;

/**
 * Ein Tool-Argument oder -Ergebnis, wie es gespeichert wird (M-9).
 *
 * Geschwärzt wird der GEPARSTE Wert: nur dort greift die Maskierung nach
 * Feldnamen (`apiKey`, `token`, `password` …). Auf dem fertigen JSON-String
 * blieben nur die Muster für `Bearer …` und `key=value` übrig. Was kein JSON
 * ist, geht als String durch dieselben Muster.
 */
function redactJsonText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactValue(text, { maxStringLength: MAX_PERSISTED_TOOL_CHARS });
  }
  const { value } = redact(parsed, {
    maxChars: MAX_PERSISTED_TOOL_CHARS,
    maxStringLength: MAX_PERSISTED_TOOL_CHARS,
    maxDepth: 8,
  });
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Schwärzt einen Tool-Aufruf vor dem Speichern — in der Chat-Session UND im
 * Chat-Activity-Log. Workflows und Recurring Tasks taten das längst
 * (`recurring-tasks.service.ts`: „the agent may echo back values returned by
 * tools"), der interaktive Chat mit der breiteren Allowlist nicht. Das LLM
 * selbst bekommt weiter den ungeschwärzten Wert; es geht nur um das, was
 * liegen bleibt.
 */
export function redactToolRecord(rec: ChatToolCallRecord): ChatToolCallRecord {
  return {
    ...rec,
    arguments: typeof rec.arguments === 'string' ? redactJsonText(rec.arguments) : rec.arguments,
    result: typeof rec.result === 'string' ? redactJsonText(rec.result) : rec.result,
    error: typeof rec.error === 'string' ? redactValue(rec.error) : rec.error,
  };
}
