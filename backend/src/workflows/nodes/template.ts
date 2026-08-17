import { isUnknownArray } from '../../common/tool-args';

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
 * placeholders. Unknown paths are left literal so failures surface in
 * downstream nodes rather than silently producing empty strings.
 */
export function expandTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const value = lookupPath(expr.trim(), context);
    if (value === undefined) return match;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

export function lookupPath(path: string, root: Record<string, unknown>): unknown {
  // Allow optional leading "context." prefix
  const cleaned = path.replace(/^context\./, '');
  const parts = cleaned.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (isPropertyBag(cur) && part in cur) {
      cur = cur[part];
    } else {
      return undefined;
    }
  }
  return cur;
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
