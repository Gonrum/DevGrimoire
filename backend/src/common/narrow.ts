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

/**
 * Wie `errorMessage`, folgt aber `.cause` bis zu zwei Ebenen tief und hängt
 * jede zusätzliche Meldung mit " — " an.
 *
 * undici's `TypeError: fetch failed` trägt das eigentlich Brauchbare
 * (ECONNREFUSED, ENOTFOUND, "unable to verify the first certificate",
 * DEPTH_ZERO_SELF_SIGNED_CERT) in `.cause`, nicht in `.message` — `errorMessage`
 * allein liefert dafür nur den nutzlosen String "fetch failed".
 *
 * Tiefe fest auf zwei Ebenen begrenzt (drei Meldungen insgesamt): genug für
 * die node/undici-Kette, ohne bei einem zyklischen `cause` (`err.cause = err`)
 * endlos zu laufen oder eine unbegrenzte Kette zusammenzusetzen. Eine Ursache
 * ohne brauchbare `.message` (kein `Error`, kein `{message: string}`) bricht
 * die Kette ab, statt "Unbekannter Fehler" anzuhängen.
 */
export function errorMessageWithCause(err: unknown): string {
  const parts = [errorMessage(err)];
  const seen = new Set<unknown>();
  if (isRecord(err)) seen.add(err);
  let current: unknown = isRecord(err) ? err.cause : undefined;
  let depth = 0;
  while (depth < 2 && current !== undefined && !seen.has(current)) {
    if (isRecord(current)) seen.add(current);
    const msg = errorMessage(current);
    if (msg === 'Unbekannter Fehler') break;
    parts.push(msg);
    current = isRecord(current) ? current.cause : undefined;
    depth += 1;
  }
  return parts.join(' — ');
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

/**
 * `new Error(msg, { cause })` — nur eben kompilierbar.
 *
 * `tsconfig.json` steht auf `target: "ES2021"` ohne eigenes `lib`, damit fehlt
 * `ErrorOptions` und die Zwei-Argument-Form von `new Error` existiert für TS
 * nicht. Die ESLint-Regel `preserve-caught-error` aus `js.configs.recommended`
 * verlangt die Ursache aber bei jedem Umwerfen — ohne diesen Helfer erfindet
 * jedes Modul seine eigene Variante (es waren schon zwei).
 *
 * Node 22 liest `.cause` als Property identisch zur Konstruktor-Form.
 *
 * Die sauberere Lösung wäre `target: "ES2022"` (Node 22 kann es vollständig);
 * das ändert aber das Emit und gehört in denselben Schritt wie `strict: true`.
 */
export function errorWithCause(message: string, cause: unknown): Error {
  const err: Error & { cause?: unknown } = new Error(message);
  err.cause = cause;
  return err;
}

/**
 * Wert gegen eine erlaubte Liste prüfen und dabei verengen.
 *
 * `allowed.find()` liefert `T | undefined` — der enge Typ entsteht also aus einer
 * echten Laufzeitprüfung statt aus einer Behauptung. Das ersetzt das verbreitete
 * `ALLOWED.includes(v as T)`, bei dem der Cast **vor** der Prüfung steht und
 * damit genau das behauptet, was geprüft werden soll.
 *
 * Generisch über `T extends string` gehalten: für einen echten TS-Enum würde ein
 * direkter Vergleich `enumWert === beliebigerString` von
 * `no-unsafe-enum-comparison` beanstandet, hier nicht.
 *
 * Für Tool-Argumente aus einem `Record<string, unknown>` gibt es die werfende
 * Variante `optionalEnum` in `tool-args.ts`; diese hier ist die stille
 * Wert-Ebene.
 */
export function pickAllowed<T extends string>(
  allowed: readonly T[],
  value: unknown,
): T | undefined {
  if (typeof value !== 'string') return undefined;
  return allowed.find((candidate) => candidate === value);
}

/**
 * Node-Stream vollständig in einen `Buffer` lesen.
 *
 * Die Schleife stand zweimal fast gleich im Projekt (Attachments, Backups), und
 * beide Male war `chunk` ein `any`: `Readable` implementiert
 * `AsyncIterableIterator<any>`, das `Buffer.from(chunk)` bekam also ein
 * ungeprüftes Argument. Die Umleitung über ein `unknown` und drei echte
 * Prüfungen kostet nichts und macht aus dem stillen `any` einen klaren Fehler,
 * falls ein Stream je etwas anderes liefert.
 */
export async function streamToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const raw of stream) {
    const chunk: unknown = raw;
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk, 'utf-8'));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new Error(`Unerwarteter Stream-Chunk vom Typ ${typeof chunk}`);
  }
  return Buffer.concat(chunks);
}
