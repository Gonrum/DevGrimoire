/**
 * POSIX-Single-Quote: nichts in Single-Quotes wird von der Shell interpretiert,
 * nur das `'` selbst nicht — das wird aus dem Quote heraus als `\'` geschrieben.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Pfad-Lookup nur über **eigene** Eigenschaften. `lookupPath` nutzt `in` und
 * löst damit `constructor`/`toString` über die Prototypkette auf — für einen
 * Shell-Befehl wäre das ein Weg zu Funktionen bzw. Nicht-Werten. Gleiche
 * `context.`-Präfix-Behandlung und Array-Indizes wie `lookupPath`.
 */
function lookupOwnPath(path: string, root: Record<string, unknown>): unknown {
  let cur: unknown = root;
  for (const part of path.replace(/^context\./, '').split('.')) {
    if (isPropertyBag(cur) && Object.prototype.hasOwnProperty.call(cur, part)) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Wert als Text oder `undefined`, wenn er nicht sicher darstellbar ist:
 * Funktionen, Symbole, BigInt, zirkuläre Strukturen und alles mit NUL-Byte
 * (sshd reicht den Befehl als C-String weiter, ein NUL würde ihn abschneiden
 * und nachfolgende Absicherungen verschwinden lassen).
 */
function renderValue(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (text === undefined || text.includes('\0')) return undefined;
  return text;
}

export type ShellExpansion =
  | { ok: true; command: string }
  | { ok: false; missing: string[]; invalid: string[]; quoted: string[] };

const PLACEHOLDER = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/y;

type QuoteState = 'none' | 'single' | 'double';

/**
 * Expandiert Platzhalter in einem Shell-Befehl. `{{ pfad }}` wird gequotet
 * (Werte stammen aus Todos/anderen Nutzern und dürfen keine Befehle einschleusen),
 * `{{{ pfad }}}` bleibt roh für bewusst vertrauenswürdige Fragmente.
 *
 * Platzhalter müssen **blank** stehen. In `"…{{t}}…"` entstünde ein
 * Single-Quote innerhalb von Double-Quotes — `$(…)` und Backticks im Wert
 * liefen wieder; in `'…{{t}}…'` hebt das eigene `'` des Quotings das äußere auf
 * und der Wert stünde ungequotet. Deshalb wird der Quote-Zustand des
 * **Templates** mitgeführt (Single-, Double-Quotes, Backslash-Escapes außerhalb
 * von Single-Quotes) und jeder Platzhalter, der innerhalb von Quotes beginnt,
 * abgelehnt: sein Pfad landet in `invalid` und zusätzlich in `quoted`, damit
 * die Fehlermeldung den Grund nennen kann. Das gilt auch für `{{{…}}}` — wer
 * roh einsetzt und dabei quotet, verlässt sich auf eine Sicherheit, die es
 * nicht gibt.
 *
 * Ein einziger Durchlauf mit der Triple-Alternative zuerst: So wird `{{{x}}}`
 * nie als `{` + `{{x}}` + `}` gelesen, und ersetzte Werte werden nicht erneut
 * als Template ausgewertet (sie gehen auch nicht in den Quote-Zustand ein).
 * Nichts wird als Literal durchgereicht: unbekannte Pfade landen in `missing`,
 * nicht darstellbare Werte (NUL, Funktion, BigInt …) in `invalid`; alle Listen
 * dedupliziert, der Befehl wird dann nicht geliefert.
 */
export function expandShellCommand(command: string, context: Record<string, unknown>): ShellExpansion {
  const { out, missing, invalid, quoted } = scanShellTemplate(command, context);
  return missing.length > 0 || invalid.length > 0
    ? { ok: false, missing, invalid, quoted }
    : { ok: true, command: out };
}

/**
 * Endet der Text innerhalb eines Quotes? Für mehrzeilige Skripte, die Zeile
 * für Zeile mit Markern dazwischen laufen: ein über die Zeile offener Quote
 * schlösse die Marker-Zeile mit ein, und ein dort eingesetztes `'…'` stünde
 * in Double-Quotes — `$(…)` im Wert liefe wieder.
 */
export function endsInsideQuotes(command: string): boolean {
  return scanShellTemplate(command, {}).state !== 'none';
}

function scanShellTemplate(
  command: string,
  context: Record<string, unknown>,
): { out: string; missing: string[]; invalid: string[]; quoted: string[]; state: QuoteState } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const quoted: string[] = [];
  const add = (list: string[], path: string) => {
    if (!list.includes(path)) list.push(path);
  };
  let out = '';
  let state: QuoteState = 'none';
  let i = 0;
  while (i < command.length) {
    PLACEHOLDER.lastIndex = i;
    const m = PLACEHOLDER.exec(command);
    if (m) {
      i += m[0].length;
      const rawPath: string | undefined = m[1];
      const path = (rawPath ?? m[2] ?? '').trim();
      if (state !== 'none') {
        add(invalid, path);
        add(quoted, path);
        continue;
      }
      const value = lookupOwnPath(path, context);
      if (value === undefined) {
        add(missing, path);
        continue;
      }
      const text = renderValue(value);
      if (text === undefined) {
        add(invalid, path);
        continue;
      }
      out += rawPath !== undefined ? text : shellQuote(text);
      continue;
    }
    const ch = command[i];
    // Backslash maskiert außerhalb von Single-Quotes das nächste Zeichen — ein
    // `\"` öffnet also keinen Quote. Beide Zeichen werden unverändert übernommen.
    if (ch === '\\' && state !== 'single' && i + 1 < command.length) {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (state === 'none') {
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
    } else if (state === 'single') {
      if (ch === "'") state = 'none';
    } else if (ch === '"') {
      state = 'none';
    }
    out += ch;
    i += 1;
  }
  return { out, missing, invalid, quoted, state };
}
