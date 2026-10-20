import { isUnknownArray } from '../../common/tool-args';
import { lookupOwnPath, renderPlaceholderValue } from './template-resolver';

/**
 * Alles, was Property-Zugriff über einen String erlaubt: Objekt **oder** Array.
 *
 * Arrays müssen mit hinein — Pfade wie `result.items.0.id` sind dokumentiert
 * (siehe `WorkflowEdge.payloadMapping`) und `{{...items.length}}` funktioniert
 * heute ebenfalls. Ein Prädikat, das Arrays ausschließt, hätte beides
 * stillschweigend zu `undefined` gemacht.
 *
 * Die eigentliche Prüfung bleibt der `in`-Test an der Aufrufstelle; hier wird
 * nur der indizierte Zugriff auf `unknown` möglich, ohne `as`.
 */
function isPropertyBag(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Replace `{{context.path.to.value}}` and `{{node.outputs.x}}`-style
 * placeholders nach den Regeln des Resolvers (`template-resolver.ts`): Lookup
 * nur über eigene Properties, `null`/`''` → leer, `\{{` bleibt wörtlich (ohne
 * Backslash), Trockenlauf-Unbekanntes → leer. Pfade, die es nicht gibt, bleiben
 * wörtlich stehen — zur Laufzeit fängt sie der Engine-Preflight vorher ab.
 */
export function expandTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(
    /(\\)?\{\{\{\s*([^}]+?)\s*\}\}\}|(\\)?\{\{\s*([^}]+?)\s*\}\}/g,
    (match: string, esc3: string | undefined, expr3: string | undefined, esc1: string | undefined, expr1: string | undefined) => {
      if (esc3 !== undefined || esc1 !== undefined) return match.slice(1);
      const found = lookupOwnPath((expr3 ?? expr1 ?? '').trim(), context);
      if (!found.found) return match;
      if (found.unknown) return '';
      return renderPlaceholderValue(found.value) ?? match;
    },
  );
}

export function lookupPath(path: string, root: Record<string, unknown>): unknown {
  return lookupOwnPath(path, root).value;
}

/** Recursively expand all string values in an object. */
export function expandConfig(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === 'string') out[k] = expandTemplate(v, context);
    // `isUnknownArray` statt `Array.isArray`: letzteres verengt ein `unknown`
    // zu `any[]` und macht damit jedes Element wieder zu `any`.
    else if (isUnknownArray(v))
      out[k] = v.map((item) =>
        typeof item === 'string'
          ? expandTemplate(item, context)
          : isPropertyBag(item)
            ? expandConfig(item, context)
            : item,
      );
    else if (isPropertyBag(v)) out[k] = expandConfig(v, context);
    else out[k] = v;
  }
  return out;
}
