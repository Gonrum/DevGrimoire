/**
 * Verengungs-Helfer für die Replikations-Engine (M-52, Lint-Gate).
 *
 * Diese Datei enthält **keine** Typ-Behauptungen. Jeder Helfer prüft zur
 * Laufzeit und liefert den engeren Typ als Ergebnis dieser Prüfung — das ist
 * der Unterschied zwischen `x as T` (behauptet) und `allowed.find(c => c === x)`
 * (belegt). Ohne diese Trennung sähe die Engine typsicher aus, während an der
 * Grenze zur Gegenstelle ungeprüfte Werte durchliefen.
 *
 * ## Leitlinie für alle Helfer hier
 *
 * Die Empfängerseite verarbeitet Daten einer **anderen Instanz**, potenziell
 * mit anderer Version. Ein Helfer darf deshalb nie *enger* entscheiden als der
 * bisherige Code: wo vorher ein unerwarteter Wert weiterverarbeitet wurde, tut
 * er das auch jetzt (`asChangeAction`), und wo vorher laut gescheitert wurde,
 * scheitert es weiter laut. Stilles Verwerfen wäre der schlimmste Ausgang —
 * es fehlen dann Einträge, ohne dass irgendwo ein Fehler auftaucht.
 */
// Nur der Typ — diese Datei bleibt zur Laufzeit abhängigkeitsfrei, damit die
// reinen Helfer (backoff, sync) sie ohne Nest-/Mongo-Kette laden können.
import type { ReplicationRole } from './replication.constants';

/**
 * Absichtlich offene Dokumentform für die replizierten Collections.
 *
 * Ohne explizites TSchema fällt der Mongo-Treiber auf `Document` =
 * `{ [k: string]: any }` zurück — dann ist **jedes** Feld `any` und die
 * `no-unsafe-*`-Familie schweigt genau dort, wo Daten fremder Herkunft
 * ankommen. `unknown` erzwingt stattdessen eine Prüfung pro Feld.
 *
 * `_id?: unknown` ist bewusst optional: `InferIdType` liefert dafür `ObjectId`,
 * also genau den Typ, mit dem die Engine ihre Filter baut.
 */
export type ReplDoc = { _id?: unknown; [field: string]: unknown };

/**
 * Formprüfung + Prädikat statt Assertion — erlaubt Feldzugriff auf `unknown`.
 *
 * Arrays gelten als Objekt (sie sind eines). Wer das ausschließen muss, prüft
 * zusätzlich `!Array.isArray(...)`; siehe `replication-sync-apply.service.ts`,
 * wo `scope` ein Objekt und ausdrücklich kein Array sein muss.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Fehlertext eines `catch (err: unknown)`.
 *
 * Ersetzt `(err as Error).message`: bei einem geworfenen Nicht-Error stand dort
 * vorher `undefined` im Log. Der Fallback ist bewusst ein fester Text und kein
 * `String(err)` — letzteres hätte für ein Objekt `[object Object]` geliefert.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  return 'unknown error';
}

/**
 * Mongo-Fehlercode, z.B. 11000 (Duplicate Key). Ersetzt
 * `(err as { code?: number }).code`; ein nicht-numerisches `code` hätte den
 * Vergleich `=== 11000` ohnehin nie erfüllt, das Verhalten ist also identisch.
 */
export function mongoErrorCode(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  return typeof err.code === 'number' ? err.code : undefined;
}

/**
 * HTTP-Status eines Axios-artigen Fehlers (`err.response.status`) — oder
 * `undefined`, wenn es keinen gibt (Netzwerkfehler, Timeout, geworfener
 * Error). Zwei echte Formprüfungen statt der bisherigen Doppel-Behauptung
 * `(err as { response?: { status?: number } })?.response?.status`.
 */
export function httpErrorStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const response = err.response;
  if (!isRecord(response)) return undefined;
  return typeof response.status === 'number' ? response.status : undefined;
}

/**
 * Bekannte Rolle oder `null`.
 *
 * `find()` liefert `ReplicationRole | undefined`, der engere Typ entsteht also
 * aus der Prüfung. Verhalten identisch zum bisherigen
 * `(await get(REPL_ROLE)) as ReplicationRole | null`: ein unbekannter String
 * fiel dort durch jede `PUSHING_ROLES.has(...)`/`=== 'peer'`-Prüfung, hier wird
 * er zu `null` und fällt durch dieselben Prüfungen.
 */
const REPLICATION_ROLES: readonly ReplicationRole[] = ['standalone', 'master', 'slave', 'peer'];

export function asReplicationRole(raw: string | null | undefined): ReplicationRole | null {
  if (raw == null) return null;
  return REPLICATION_ROLES.find((candidate) => candidate === raw) ?? null;
}

/**
 * Action eines Legacy-Queue-Eintrags in die Wire-Form.
 *
 * **Kein** Verwerfen bei unbekanntem Wert: die Empfängerseite behandelt alles
 * außer `'deleted'` als Upsert, ein unbekannter String lief also bisher schon
 * in den Upsert-Pfad. `'updated'` reproduziert das exakt. Ein Eintrag darf hier
 * unter keinen Umständen verloren gehen — er ist die letzte Kopie eines
 * fehlgeschlagenen Pushs.
 */
export function asChangeAction(value: unknown): 'created' | 'updated' | 'deleted' {
  if (value === 'deleted') return 'deleted';
  if (value === 'created') return 'created';
  return 'updated';
}

/**
 * Datumswert aus einem Mongo-Feld. Nur `Date`, String und Number sind sinnvolle
 * Eingaben; alles andere ergäbe ein Invalid Date, das über den NaN-Zweig
 * ohnehin zu `null` geworden wäre.
 */
export function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Zähler aus einer Gegenstellen-Antwort. Nur echte finite Zahlen zählen — ein
 * `"5"` hätte über `total += resp.entities` aus der Zahl einen String gemacht
 * (`0 + "5" === "05"`) und alle Folgezählungen verfälscht.
 */
export function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Ein Stream-Chunk als Buffer. Der MinIO-Client typisiert seinen Readable auf
 * `any`, also kommt hier `unknown` an; `Buffer.isBuffer` und `instanceof` sind
 * echte Prüfungen.
 *
 * Der unerwartete Typ **wirft** statt `null` zu liefern. Das ist Absicht: ein
 * übersprungener Chunk wäre eine still beschädigte Datei. Das bisherige
 * `Buffer.from(chunk)` warf für so einen Wert ebenfalls, der aufrufende
 * try/catch überspringt dann den Anhang komplett — laut und vollständig statt
 * leise und halb.
 */
export function chunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new TypeError(`Unexpected stream chunk type: ${typeof chunk}`);
}
