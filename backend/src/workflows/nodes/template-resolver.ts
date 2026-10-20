import { isRecord, isUnknownArray } from '../../common/tool-args';

/**
 * Zentraler Platzhalter-Resolver für alle Node-Typen.
 *
 * Eine Stelle, die entscheidet, was `{{pfad}}` bedeutet — Engine-Preflight,
 * Trockenlauf, Debug-UI und `expandTemplate` lesen dieselben Regeln. Vorher
 * blieb ein unbekannter Pfad stillschweigend wörtlich stehen und fiel erst
 * in einem nachgelagerten Node auf.
 */

/** Anzeige-Maske für Secret-Werte in Freitext. */
export const SECRET_MASK = '••••';

/** Secret-Werte kürzer als das lassen sich in Freitext nicht sinnvoll maskieren. */
const MIN_MASKED_LENGTH = 4;
const PREVIEW_MAX = 200;

export type PlaceholderStatus = 'resolved' | 'empty' | 'missing' | 'unknown' | 'secret' | 'secret_forbidden';

export interface PlaceholderTrace {
  /** Pfad in der Config, z.B. 'command', 'tags.0', 'retry.maxAttempts'. */
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

export interface ResolveOptions {
  secrets?: Record<string, string>;
  secretsAllowed: boolean;
}

export interface ResolvedConfig {
  /** false bei missing.length || forbiddenSecrets.length. */
  ok: boolean;
  /** Echte Werte — nur im Speicher halten, nie persistieren. */
  value: Record<string, unknown>;
  /** Wie `value`, Secrets als ••••(KEY). */
  display: Record<string, unknown>;
  placeholders: PlaceholderTrace[];
  /** exprs, dedupliziert, in Auftrittsreihenfolge. */
  missing: string[];
  /** KEYs. */
  forbiddenSecrets: string[];
}

export class TemplateUnresolvedError extends Error {
  constructor(readonly missing: string[]) {
    super(`Platzhalter nicht auflösbar: ${missing.join(', ')}`);
    this.name = 'TemplateUnresolvedError';
  }
}

/**
 * `\{{…}}` / `\{{{…}}}` (Gruppe 1/3 = Backslash) → wörtlich ohne Backslash.
 * Triple-Alternative zuerst, damit `{{{x}}}` nie als `{` + `{{x}}` + `}` gelesen wird.
 */
function placeholderRegex(): RegExp {
  return /(\\)?\{\{\{\s*([^}]+?)\s*\}\}\}|(\\)?\{\{\s*([^}]+?)\s*\}\}/g;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Objekt **oder** Array — Pfade wie `result.items.0.id` sind dokumentiert. */
function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Pfad-Lookup nur über **eigene** Eigenschaften: `in` würde `constructor`
 * oder `__proto__` über die Prototypkette auflösen.
 *
 * `unknown`: Ein Trockenlauf-Node (`dryRun === true`) liefert keine echten
 * Ausgaben. Ist ein Zwischenobjekt ein eigenes `dryRun === true` und der Rest
 * des Pfads nicht vorhanden oder `null`, ist der Wert nicht „fehlend", sondern
 * nur noch nicht bekannt.
 */
export function lookupOwnPath(path: string, root: unknown): { found: boolean; value: unknown; unknown: boolean } {
  let cur: unknown = root;
  let dryAncestor = false;
  for (const part of path.replace(/^context\./, '').split('.')) {
    if (isPropertyBag(cur) && hasOwn(cur, part) && cur[part] !== undefined) {
      if (hasOwn(cur, 'dryRun') && cur.dryRun === true) dryAncestor = true;
      cur = cur[part];
    } else {
      if (dryAncestor || (isPropertyBag(cur) && hasOwn(cur, 'dryRun') && cur.dryRun === true)) {
        return { found: true, value: undefined, unknown: true };
      }
      return { found: false, value: undefined, unknown: false };
    }
  }
  if (cur === null && dryAncestor) return { found: true, value: undefined, unknown: true };
  return { found: true, value: cur, unknown: false };
}

/**
 * Wert als Text; `undefined`, wenn er nicht darstellbar ist (Funktion, Symbol,
 * BigInt, zirkuläre Struktur). `null` und `''` ergeben `''`.
 */
export function renderPlaceholderValue(value: unknown): string | undefined {
  if (value === null || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function secretKeyOf(expr: string): string | undefined {
  const cleaned = expr.replace(/^context\./, '');
  return cleaned.startsWith('secrets.') && cleaned.length > 'secrets.'.length
    ? cleaned.slice('secrets.'.length)
    : undefined;
}

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
}

interface Accumulator {
  placeholders: PlaceholderTrace[];
  missing: string[];
  forbidden: string[];
}

function addUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

function resolveString(
  input: string,
  field: string,
  context: Record<string, unknown>,
  opts: ResolveOptions,
  acc: Accumulator,
): { value: string; display: string } {
  let value = '';
  let display = '';
  let last = 0;
  const re = placeholderRegex();
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    const between = input.slice(last, m.index);
    value += between;
    display += between;
    last = m.index + m[0].length;
    const raw = m[2] !== undefined;
    const escaped = (raw ? m[1] : m[3]) !== undefined;
    const literal = m[0].slice(escaped ? 1 : 0);
    if (escaped) {
      value += literal;
      display += literal;
      continue;
    }
    const expr = (m[2] ?? m[4] ?? '').trim();
    const line = input.slice(0, m.index).split('\n').length;
    const trace = (status: PlaceholderStatus, pv?: string): void => {
      acc.placeholders.push({ field, line, expr, raw, status, ...(pv !== undefined ? { preview: pv } : {}) });
    };
    const keep = (): void => {
      value += literal;
      display += literal;
    };

    const key = secretKeyOf(expr);
    if (key !== undefined) {
      if (!opts.secretsAllowed) {
        addUnique(acc.forbidden, key);
        trace('secret_forbidden');
        keep();
        continue;
      }
      const secret = opts.secrets !== undefined && hasOwn(opts.secrets, key) ? opts.secrets[key] : undefined;
      if (typeof secret !== 'string') {
        addUnique(acc.missing, expr);
        trace('missing');
        keep();
        continue;
      }
      const shown = `${SECRET_MASK}(${key})`;
      value += secret;
      display += shown;
      trace('secret', shown);
      continue;
    }

    const found = lookupOwnPath(expr, context);
    if (!found.found) {
      addUnique(acc.missing, expr);
      trace('missing');
      keep();
      continue;
    }
    if (found.unknown) {
      trace('unknown');
      continue;
    }
    const text = renderPlaceholderValue(found.value);
    if (text === undefined) {
      addUnique(acc.missing, expr);
      trace('missing');
      keep();
      continue;
    }
    value += text;
    display += text;
    trace(text === '' ? 'empty' : 'resolved', preview(text));
  }
  const rest = input.slice(last);
  return { value: value + rest, display: display + rest };
}

/** Nur schlichte Objekte werden durchlaufen; Date & Co. bleiben unverändert. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(
  node: unknown,
  field: string,
  context: Record<string, unknown>,
  opts: ResolveOptions,
  acc: Accumulator,
): { value: unknown; display: unknown } {
  if (typeof node === 'string') return resolveString(node, field, context, opts, acc);
  const join = (k: string | number): string => (field === '' ? String(k) : `${field}.${k}`);
  if (isUnknownArray(node)) {
    const value: unknown[] = [];
    const display: unknown[] = [];
    node.forEach((item, i) => {
      const r = walk(item, join(i), context, opts, acc);
      value.push(r.value);
      display.push(r.display);
    });
    return { value, display };
  }
  if (isPlainObject(node)) {
    const value: Record<string, unknown> = {};
    const display: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = walk(v, join(k), context, opts, acc);
      value[k] = r.value;
      display[k] = r.display;
    }
    return { value, display };
  }
  return { value: node, display: node };
}

export function resolveConfig(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  opts: ResolveOptions,
): ResolvedConfig {
  const acc: Accumulator = { placeholders: [], missing: [], forbidden: [] };
  const value: Record<string, unknown> = {};
  const display: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const r = walk(v, k, context, opts, acc);
    value[k] = r.value;
    display[k] = r.display;
  }
  return {
    ok: acc.missing.length === 0 && acc.forbidden.length === 0,
    value,
    display,
    placeholders: acc.placeholders,
    missing: acc.missing,
    forbiddenSecrets: acc.forbidden,
  };
}

/** Alle KEYs aus `{{secrets.X}}` / `{{{secrets.X}}}`, dedupliziert, ohne escapte. */
export function findSecretKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const re = placeholderRegex();
      for (let m = re.exec(node); m !== null; m = re.exec(node)) {
        const raw = m[2] !== undefined;
        if ((raw ? m[1] : m[3]) !== undefined) continue;
        const key = secretKeyOf((m[2] ?? m[4] ?? '').trim());
        if (key !== undefined) addUnique(keys, key);
      }
    } else if (isUnknownArray(node)) {
      node.forEach(visit);
    } else if (isPlainObject(node)) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return keys;
}

function maskUnknown(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const s of secrets) out = out.split(s).join(SECRET_MASK);
    return out;
  }
  if (isUnknownArray(value)) return value.map((v) => maskUnknown(v, secrets));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskUnknown(v, secrets);
    return out;
  }
  return value;
}

/**
 * Ersetzt Secret-Werte tief in allen Strings durch die Maske. Werte unter 4
 * Zeichen werden ausgelassen (sie würden beliebigen Text zerstören); längste
 * zuerst, damit ein Wert, der Präfix eines anderen ist, diesen nicht zerlegt.
 */
export function maskSecrets<T>(value: T, secretValues: string[]): T;
export function maskSecrets(value: unknown, secretValues: string[]): unknown {
  const usable = [...new Set(secretValues)]
    .filter((s) => s.length >= MIN_MASKED_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (usable.length === 0) return value;
  return maskUnknown(value, usable);
}
