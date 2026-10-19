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
  | { ok: false; missing: string[]; invalid: string[] };

/**
 * Expandiert Platzhalter in einem Shell-Befehl. `{{ pfad }}` wird gequotet
 * (Werte stammen aus Todos/anderen Nutzern und dürfen keine Befehle einschleusen),
 * `{{{ pfad }}}` bleibt roh für bewusst vertrauenswürdige Fragmente.
 *
 * `{{…}}` muss **blank** stehen: Wer es selbst in Quotes setzt (`'{{t}}'`,
 * `"{{t}}"`), bricht das Quoting auf — das Ergebnis wäre `''x''` bzw. ein
 * Quote innerhalb von Double-Quotes und damit nicht mehr sicher.
 *
 * Ein einziger Durchlauf mit der Triple-Alternative zuerst: So wird `{{{x}}}`
 * nie als `{` + `{{x}}` + `}` gelesen, und ersetzte Werte werden nicht erneut
 * als Template ausgewertet. Nichts wird als Literal durchgereicht: unbekannte
 * Pfade landen in `missing`, nicht darstellbare Werte (NUL, Funktion, BigInt …)
 * in `invalid`; beide Listen dedupliziert, der Befehl wird dann nicht geliefert.
 */
export function expandShellCommand(command: string, context: Record<string, unknown>): ShellExpansion {
  const missing: string[] = [];
  const invalid: string[] = [];
  const expanded = command.replace(
    /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, rawPath: string | undefined, quotedPath: string | undefined) => {
      const path = (rawPath ?? quotedPath ?? '').trim();
      const value = lookupOwnPath(path, context);
      if (value === undefined) {
        if (!missing.includes(path)) missing.push(path);
        return '';
      }
      const text = renderValue(value);
      if (text === undefined) {
        if (!invalid.includes(path)) invalid.push(path);
        return '';
      }
      return rawPath !== undefined ? text : shellQuote(text);
    },
  );
  return missing.length > 0 || invalid.length > 0
    ? { ok: false, missing, invalid }
    : { ok: true, command: expanded };
}
