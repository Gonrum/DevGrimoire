/**
 * Laufzeit-Verengungen für die Workflow-Engine (M-52).
 *
 * Node-Konfigurationen und Node-Outputs sind **strukturell offen**: beides
 * liegt als `Record<string, unknown>` bzw. als Mongo-`Mixed` in der DB, wird
 * vom Graph-Editor, von einem Template oder von `expandConfig` geschrieben und
 * erst beim Aktivieren des Workflows gegen das zod-`configSchema` des
 * Node-Typs geprüft (`WorkflowsService.updateDefinition`). In der Engine ist
 * ein solcher Wert deshalb `unknown` — und wird hier an der Verwendungsstelle
 * verengt, statt per Assertion behauptet.
 *
 * Für Werte, die aus einem `Record<string, unknown>` gelesen werden, sind die
 * Helfer aus `src/common/tool-args.ts` die erste Wahl (`asString`,
 * `optionalEnum`, `isUnknownArray`, `countArray`). Hier steht nur, was dort
 * fehlt.
 *
 * **Doppelung, bewusst benannt:** `isRecord` und `errorMessage` gibt es im
 * Backend inzwischen mehrfach (`rag`, `notes`, `milestones`, `replication`).
 * Sie gehören nach `src/common/` — solange das nicht passiert ist, liegt die
 * Workflow-Kopie hier statt als Querimport auf ein fremdes Modul.
 */
import { isUnknownArray } from '../common/tool-args';

/**
 * Formprüfung + Prädikat statt Assertion — erlaubt Feldzugriff auf `unknown`.
 *
 * Arrays gelten hier **nicht** als Record: die Aufrufer verengen damit
 * Konfigurations- und Output-Objekte, und `Object.entries` auf einem Array
 * hätte dort numerische Schlüssel geliefert. Wer ein Array meint, nimmt
 * `isUnknownArray`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fehlertext eines `catch (err: unknown)`.
 *
 * Ersetzt `(err as Error).message`: bei einem geworfenen Nicht-Error stand
 * dort vorher `undefined` im Log. Der Fallback ist bewusst ein fester Text und
 * kein `String(err)` — letzteres hätte für ein Objekt `[object Object]`
 * geliefert.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  return 'unknown error';
}

/**
 * `err.name` eines geworfenen Fehlers. Die Engine unterscheidet damit ihren
 * eigenen `TimeoutError` von allem anderen; ein Nicht-Error hat keinen Namen
 * und ist damit — wie vorher — kein Timeout.
 */
export function errorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  if (isRecord(err) && typeof err.name === 'string') return err.name;
  return undefined;
}

/**
 * Mongo-Fehlercode, z.B. 11000 (Duplicate Key). Ersetzt
 * `(err as { code?: number }).code`; ein nicht-numerisches `code` hätte den
 * Vergleich `=== 11000` ohnehin nie erfüllt — das Verhalten ist identisch.
 */
export function mongoErrorCode(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  return typeof err.code === 'number' ? err.code : undefined;
}

/**
 * Zahl aus einem offenen Konfigurationsfeld.
 *
 * Numerische Strings werden übernommen, weil die Trigger- und Node-Konfiguration
 * über JSON aus dem Editor kommt und ein `"intervalMinutes": "15"` dort bisher
 * durch die impliziten JS-Coercions (`"15" > 0`, `"15" * 60000`) funktioniert
 * hat. Strikte Ablehnung hätte solche Workflows still zum Stehen gebracht.
 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * String-Array aus einem offenen Konfigurationsfeld — oder `undefined`, wenn
 * der Wert kein Array ist oder ein Element kein String ist.
 *
 * Bewusst alles-oder-nichts: einzelne Elemente still zu verwerfen würde aus
 * `tags: ["a", 1, "b"]` eine plausibel aussehende, aber falsche Liste machen.
 */
export function asStringArray(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return undefined;
    out.push(entry);
  }
  return out;
}

/**
 * Objekt mit ausschließlich String-Werten (z.B. `WorkflowEdge.payloadMapping`)
 * — oder `undefined`, wenn ein Wert keiner ist.
 *
 * Für `payloadMapping` heißt das: eine Zuordnung mit einem Nicht-String-Pfad
 * greift gar nicht mehr, statt in `lookupPath` an `path.replace` zu scheitern
 * und den Run mitzureißen.
 */
export function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined;
    out[key] = entry;
  }
  return out;
}
