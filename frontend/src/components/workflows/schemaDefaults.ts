type JsonSchema = Record<string, unknown>;

export function getDefaultsFromJsonSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schema.type;
  if (type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const out: Record<string, unknown> = {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const [k, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
      if (required.includes(k)) {
        out[k] = getDefaultsFromJsonSchema(sub);
      }
    }
    return out;
  }
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return undefined;
}
