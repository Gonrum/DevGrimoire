import { lookupPath } from './template';

/**
 * POSIX-Single-Quote: nichts in Single-Quotes wird von der Shell interpretiert,
 * nur das `'` selbst nicht — das wird aus dem Quote heraus als `\'` geschrieben.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export type ShellExpansion = { ok: true; command: string } | { ok: false; missing: string[] };

/**
 * Expandiert Platzhalter in einem Shell-Befehl. `{{ pfad }}` wird gequotet
 * (Werte stammen aus Todos/anderen Nutzern und dürfen keine Befehle einschleusen),
 * `{{{ pfad }}}` bleibt roh für bewusst vertrauenswürdige Fragmente.
 *
 * Ein einziger Durchlauf mit der Triple-Alternative zuerst: So wird `{{{x}}}`
 * nie als `{` + `{{x}}` + `}` gelesen, und ersetzte Werte werden nicht erneut
 * als Template ausgewertet. Unbekannte Pfade werden nie als Literal
 * durchgereicht (das wäre ein Teil eines Shell-Befehls), sondern gesammelt
 * gemeldet.
 */
export function expandShellCommand(command: string, context: Record<string, unknown>): ShellExpansion {
  const missing: string[] = [];
  const expanded = command.replace(
    /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*([^}]+?)\s*\}\}/g,
    (_match, rawPath: string | undefined, quotedPath: string | undefined) => {
      const path = (rawPath ?? quotedPath ?? '').trim();
      const value = lookupPath(path, context);
      if (value === undefined) {
        if (!missing.includes(path)) missing.push(path);
        return '';
      }
      const text = stringify(value);
      return rawPath !== undefined ? text : shellQuote(text);
    },
  );
  return missing.length > 0 ? { ok: false, missing } : { ok: true, command: expanded };
}
