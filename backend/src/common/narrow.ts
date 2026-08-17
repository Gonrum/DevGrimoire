/**
 * Generische Verengungs-Prädikate (M-52).
 *
 * Absichtlich importfrei: keine Nest-, Mongoose- oder Projektabhängigkeiten,
 * damit diese Datei auch von Modulen genutzt werden kann, die von `.cjs`-Checks
 * direkt aus `dist/` geladen werden, ohne dass eine Nest-Kette mitkommt.
 *
 * **Prädikate statt Assertions.** Ein `value as T` behauptet; ein Prädikat
 * `value is T` prüft. Das ist nicht Kosmetik: `no-unsafe-type-assertion` fängt
 * die Behauptung, und wichtiger — die Prüfung existiert dann auch zur Laufzeit.
 */

/** Ein Objekt mit unbekannten Feldern. Der Weg, ein Feld von `unknown` zu lesen. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Aufrufbar ohne Argumente, Ergebnis `unknown`.
 *
 * Warum nicht einfach `typeof x === 'function'`: das verengt nur zu `Function`,
 * und `Function.prototype.call` liefert `any` — womit die gesamte
 * `no-unsafe-*`-Familie zurückkommt. Dieses Prädikat sagt das Schwächste, worauf
 * man sich tatsächlich verlässt.
 */
export function isNullaryMethod(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

/**
 * Meldungstext aus einem geworfenen Wert.
 *
 * Ersetzt das projektweite `(err as Error).message`, das für jeden Nicht-Error
 * den Literalstring `undefined` in Logs und Nutzermeldungen schrieb — im
 * Projekt real aufgetreten als „Partial import for todos: undefined".
 *
 * Bewusst **kein** `JSON.stringify`-Fallback: das wirft bei einem zyklischen
 * Objekt und würde dann den `catch`-Block mitnehmen, in dem es steht.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return 'Unbekannter Fehler';
}

/** MongoDB-Fehlercode, sofern vorhanden. `11000` ist der Duplicate-Key-Fehler. */
export function mongoErrorCode(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  return typeof err.code === 'number' ? err.code : undefined;
}

/**
 * Duplicate-Key-Prüfung. Das Muster `(err as { code?: number }).code === 11000`
 * stand rund zehnmal im Backend, jedes Mal mit eigenem Cast.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return mongoErrorCode(err) === 11000;
}
