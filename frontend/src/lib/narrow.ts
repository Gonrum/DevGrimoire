/**
 * Generische Verengungs-Prädikate für das Frontend (M-52 / T-457).
 *
 * Das Gegenstück zu `backend/src/common/narrow.ts`, mit derselben Begründung:
 * **Prädikate statt Assertions.** Ein `value as T` behauptet; ein Prädikat
 * `value is T` prüft. `no-unsafe-type-assertion` fängt die Behauptung — und
 * wichtiger: die Prüfung existiert dann auch zur Laufzeit.
 *
 * Absichtlich importfrei (kein React, kein `api/client`), damit die Datei von
 * jeder Schicht genutzt werden kann.
 */

/** Ein Objekt mit unbekannten Feldern. Der Weg, ein Feld von `unknown` zu lesen. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `unknown[]` statt `any[]`.
 *
 * `Array.isArray(x)` auf einem `unknown` verengt zu `any[]` — ab da ist jeder
 * Elementzugriff wieder `any` und die ganze `no-unsafe-*`-Familie kommt zurück.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Meldungstext aus einem geworfenen Wert.
 *
 * Ersetzt das im Frontend rund 60-mal wiederholte `catch (e: any) { e.message }`
 * bzw. `(err as Error).message`. Beide Formen hatten denselben Defekt: bei einem
 * geworfenen `null`/`undefined` wirft `err.message` **im catch-Block selbst**
 * einen TypeError — der ursprüngliche Fehler ist damit weg und der Nutzer sieht
 * gar nichts mehr.
 *
 * `fallback` erhält die lokalisierte Ersatzmeldung der Aufrufstelle
 * (`t('common.errorSaving')` o.ä.); ohne Angabe bleibt ein neutraler Text.
 *
 * Bewusst **kein** `JSON.stringify`-Fallback: das wirft bei einem zyklischen
 * Objekt und würde dann den `catch`-Block mitnehmen, in dem es steht.
 */
export function errorMessage(err: unknown, fallback = 'Unbekannter Fehler'): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err || fallback;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (isRecord(err) && typeof err.message === 'string' && err.message.length > 0) {
    return err.message;
  }
  return fallback;
}

/**
 * Wert aus einer Optionsliste, sonst `undefined`.
 *
 * Das Muster `e.target.value as SomeUnion` stand rund 20-mal in den
 * Komponenten. `HTMLSelectElement.value` ist `string`; der Cast behauptete die
 * Union, ohne sie zu prüfen. Passiert real, wenn ein Options-Wert umbenannt
 * wird und ein Filter-State im `localStorage`/URL-Parameter den alten Wert
 * hält: der State enthält dann einen Wert, den kein Zweig kennt.
 *
 * `find` liefert `T | undefined` **ohne** Assertion — deshalb `find` und nicht
 * `includes`.
 */
export function matchOption<T extends string>(value: string, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

/** Wie `matchOption`, nur mit Rückfallwert statt `undefined`. */
export function optionOr<T extends string>(value: string, options: readonly T[], fallback: T): T {
  return matchOption(value, options) ?? fallback;
}
