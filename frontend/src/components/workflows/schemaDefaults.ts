import { isRecord, isUnknownArray } from '../../lib/narrow';

type JsonSchema = Record<string, unknown>;

export function getDefaultsFromJsonSchema(schema: JsonSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  const type = schema.type;
  if (type === 'object' && isRecord(schema.properties)) {
    const out: Record<string, unknown> = {};
    const required = isUnknownArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (required.includes(k)) {
        // Ein Nicht-Objekt an dieser Stelle ist kein Schema; das leere Schema
        // liefert `undefined` und damit denselben "kein Default"-Ausgang.
        out[k] = isRecord(sub) ? getDefaultsFromJsonSchema(sub) : undefined;
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
