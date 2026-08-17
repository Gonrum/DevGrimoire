/**
 * Leser für Tool-Argumente (M-52 / T-457).
 *
 * MCP- und Chat-Schicht bekommen ihre Argumente als `Record<string, unknown>`
 * aus JSON, das ein LLM erzeugt hat — also grundsätzlich ungeprüft. Diese Datei
 * ist die **eine** Stelle, an der daraus getypte Werte werden.
 *
 * Vorher lag derselbe Satz Helfer doppelt in `mcp-tools.ts` und in Teilen in
 * `chat-tools.ts`; letztere behalf sich zusätzlich an 29 Stellen mit `as never`,
 * weil die Services echte TS-String-Enums erwarten und ein String-Literal-Union
 * dorthin nicht zuweisbar ist. `never` ist allem zuweisbar — der Linter schwieg,
 * ungeprüfte Strings liefen bis in die Enum-Felder.
 *
 * ## Welchen Helfer wann
 *
 * - **Enum-Feld → `optionalEnum` / `requireEnum`.** Die richtige Wahl, wo die
 *   erlaubten Werte bekannt sind: `allowed.find()` liefert `T | undefined`, der
 *   verengte Typ entsteht also **ohne Assertion**, und der Aufrufer bekommt
 *   „must be one of: …" statt eines Mongoose-Validierungsfehlers.
 * - **Freitext → `optionalString` / `requireString`.** Liefert `string`, keine
 *   Verengung. Wer hier einen engeren Typ braucht, will `optionalEnum`.
 * - **Verschachteltes Objekt/Array → `optionalObject` / `optionalObjectArray`.**
 *   Diese prüfen zur Laufzeit nur die *Form* (Objekt bzw. Array); die
 *   Element-Struktur validiert der Service über class-validator oder Mongoose.
 *   Sie brauchen deshalb eine Assertion — siehe Hinweis unten.
 *
 * ## Hinweis zur Regel `no-unsafe-type-assertion`
 *
 * Für diese Datei ist sie in `eslint.config.mjs` per Override abgeschaltet, mit
 * Begründung dort. Grund in einem Satz: an der Grenze zwischen ungeprüftem JSON
 * und einem DTO-Typ ist eine Behauptung unvermeidbar, solange kein Schema-
 * Validator dazwischensteht. Sie gehört dann **hierher** — geprüft, benannt und
 * an einer Stelle — und nicht als `eslint-disable` in hundert Aufrufer.
 */

export type ToolArgs = Record<string, unknown>;

/** Plain, serialisierbare Form eines Dokuments. */
export type PlainDoc = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

export function requireString(args: ToolArgs, field: string): string {
  const val = args[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return val;
}

export function optionalString(args: ToolArgs, field: string): string | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`${field} must be a string`);
  return val;
}

// ---------------------------------------------------------------------------
// Enums — der Weg ohne Assertion
// ---------------------------------------------------------------------------

/**
 * `allowed.find()` gibt `T | undefined` zurück. Der verengte Typ entsteht damit
 * aus einer echten Laufzeitprüfung statt aus einer Behauptung — genau der
 * Unterschied zu `optionalString(...) as T`, das nichts prüft.
 *
 * Für ein TS-String-Enum: `optionalEnum(args, 'status', Object.values(TodoStatus))`.
 */
export function optionalEnum<T extends string>(
  args: ToolArgs,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const val = optionalString(args, field);
  if (val === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === val);
  if (match === undefined) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return match;
}

export function requireEnum<T extends string>(
  args: ToolArgs,
  field: string,
  allowed: readonly T[],
): T {
  const val = optionalEnum(args, field, allowed);
  if (val === undefined) throw new Error(`Missing required field: ${field}`);
  return val;
}

// ---------------------------------------------------------------------------
// Arrays und Objekte
// ---------------------------------------------------------------------------

/**
 * Typprädikat statt `Array.isArray`: letzteres verengt ein `unknown` zu `any[]`
 * und holt damit die unsafe-Findings auf den Elementen zurück.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return isUnknownArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Ein einzelner String wird toleriert: mit Kommas als Liste interpretiert, sonst
 * eingepackt. LLM-Clients schicken Listen gerne als `"a,b"` statt `["a","b"]`.
 */
export function optionalStringArray(args: ToolArgs, field: string): string[] | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'string') {
    return val.includes(',')
      ? val.split(',').map((entry) => entry.trim()).filter(Boolean)
      : [val];
  }
  if (!isStringArray(val)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return val;
}

/**
 * Prüft die Form (Objekt, kein Array) und behauptet dann den Element-Typ. Die
 * Struktur validiert der Service — deshalb die Assertion, und deshalb genau
 * hier statt an jeder Aufrufstelle.
 */
export function requireObject<T extends object = PlainDoc>(args: ToolArgs, field: string): T {
  const val = args[field];
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`Missing required object field: ${field}`);
  }
  return val as T;
}

export function optionalObject<T extends object = PlainDoc>(
  args: ToolArgs,
  field: string,
): T | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`${field} must be an object`);
  }
  return val as T;
}

/**
 * Array-Argument in der vom Service erwarteten Element-Form. Die Array-Prüfung
 * passiert hier zur Laufzeit; die Element-Struktur validiert der Service.
 */
export function optionalObjectArray<T>(args: ToolArgs, field: string): T[] | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (!isUnknownArray(val)) throw new Error(`${field} must be an array`);
  return val as T[];
}

// ---------------------------------------------------------------------------
// Skalare
// ---------------------------------------------------------------------------

export function optionalBoolean(args: ToolArgs, field: string): boolean | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new Error(`${field} must be a boolean`);
  return val;
}

export function optionalNumber(args: ToolArgs, field: string): number | undefined {
  const val = args[field];
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') return val;
  // Manche LLM-Clients stringifizieren Zahlen, obwohl das JSON-Schema `number`
  // deklariert. Ein `"limit": "5"` soll den Tool-Call nicht scheitern lassen.
  if (typeof val === 'string' && val.trim() !== '' && !Number.isNaN(Number(val))) {
    return Number(val);
  }
  throw new Error(`${field} must be a number`);
}

export function requireNumber(args: ToolArgs, field: string): number {
  const val = optionalNumber(args, field);
  if (val === undefined) throw new Error(`Missing required number field: ${field}`);
  return val;
}

// ---------------------------------------------------------------------------
// Dokument-Normalisierung
// ---------------------------------------------------------------------------

/**
 * Normalisiert ein Mongoose-Dokument oder ein Plain Object auf dieselbe Form.
 *
 * `toJSON` wird per Duck-Typing geprüft statt über einen mongoose-Import: diese
 * Datei liegt in `common/` und soll nicht an die Persistenz gebunden sein.
 *
 * **Wichtig:** niemals `{ ...doc }` auf einem Mongoose-Dokument benutzen. Die
 * Schema-Felder sind Prototype-Getter, keine eigenen Properties —
 * `Object.keys({ ...doc })` ergibt `["$__","_doc"]`, alle Felder fehlen. Genau
 * dieser Fehler hat in `milestone_ai_complete` dafür gesorgt, dass das Modell
 * ObjectIds statt Todo-Nummern sah und jedes Akzeptanzkriterium als unabgehakt.
 *
 * Für den Roh-Export ohne Schema-Transforms ist `toObject` das richtige — siehe
 * `project-transfer.service.ts`, das deshalb eine eigene Variante hat.
 */
export function toPlainDoc(doc: unknown): PlainDoc {
  if (doc === null || typeof doc !== 'object') return {};
  const toJSON = (doc as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    const json: unknown = (toJSON as () => unknown).call(doc);
    if (json !== null && typeof json === 'object') return json as PlainDoc;
  }
  return { ...(doc as PlainDoc) };
}

/** Liest ein Feld eines PlainDoc als String — oder undefined, wenn es keiner ist. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Länge eines Feldes, das ein Array sein sollte; 0 wenn nicht. */
export function countArray(value: unknown): number {
  return isUnknownArray(value) ? value.length : 0;
}

/** Narrowt eine unbekannte HTTP-Antwort auf ein Array von Objekten. */
export function asObjectArray(value: unknown): PlainDoc[] {
  if (!isUnknownArray(value)) return [];
  return value.filter((entry): entry is PlainDoc => entry !== null && typeof entry === 'object');
}

/**
 * Mongo-Id zu String. Nur String, Number und Werte mit eigenem `toString` gelten;
 * ein blankes `String(value)` hätte für ein Objekt `[object Object]` geliefert.
 */
export function idToString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number') return String(value);
  const maybe = value as { toString?: () => string };
  if (typeof maybe.toString !== 'function') return undefined;
  const str = maybe.toString();
  return str && str !== '[object Object]' ? str : undefined;
}
