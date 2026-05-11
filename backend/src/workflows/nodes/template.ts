/**
 * Replace `{{context.path.to.value}}` and `{{node.outputs.x}}`-style
 * placeholders. Unknown paths are left literal so failures surface in
 * downstream nodes rather than silently producing empty strings.
 */
export function expandTemplate(input: string, context: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, expr: string) => {
    const value = lookup(expr.trim(), context);
    if (value === undefined) return match;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

function lookup(path: string, root: Record<string, unknown>): unknown {
  // Allow optional leading "context." prefix
  const cleaned = path.replace(/^context\./, '');
  const parts = cleaned.split('.');
  let cur: unknown = root;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
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
    else if (Array.isArray(v))
      out[k] = v.map((item) =>
        typeof item === 'string'
          ? expandTemplate(item, context)
          : item && typeof item === 'object'
            ? expandConfig(item as Record<string, unknown>, context)
            : item,
      );
    else if (v && typeof v === 'object') out[k] = expandConfig(v as Record<string, unknown>, context);
    else out[k] = v;
  }
  return out;
}
