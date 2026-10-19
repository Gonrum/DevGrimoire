import { isRecord } from '../common/narrow';

/**
 * Was ein Lauf von einer Definition tatsächlich benutzt — ohne Layout
 * (Position, Labels, `ui`). Ein aktiver Workflow bekommt nur dann eine neue
 * Version samt Freigabe, wenn sich dieser Fingerabdruck ändert. Vorher zählte
 * jedes Autosave hoch: Node verschieben = neue Version + neue Freigabe.
 */
export interface RuntimeShape {
  nodes?: unknown;
  edges?: unknown;
  trigger?: unknown;
}

const NODE_RUNTIME_KEYS = ['id', 'type', 'config', 'secretRefs', 'inputs', 'outputs'] as const;
const EDGE_RUNTIME_KEYS = [
  'source',
  'target',
  'sourcePort',
  'targetPort',
  'branch',
  'condition',
  'payloadMapping',
] as const;

export function runtimeFingerprint(def: RuntimeShape): string {
  // Über JSON gehen: Mongoose-Subdokumente liefern so ihre Daten, und
  // `undefined`-Felder verschwinden wie beim Speichern.
  const plain: unknown = JSON.parse(JSON.stringify({
    nodes: def.nodes ?? [],
    edges: def.edges ?? [],
    trigger: def.trigger ?? null,
  }));
  if (!isRecord(plain)) return '';
  const nodes = asList(plain.nodes).map((n) => pick(n, NODE_RUNTIME_KEYS));
  const edges = asList(plain.edges).map((e) => pick(e, EDGE_RUNTIME_KEYS));
  return stableStringify({
    nodes: sortByJson(nodes),
    edges: sortByJson(edges),
    trigger: plain.trigger ?? null,
  });
}

function asList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Reihenfolge von Nodes/Edges ist für den Lauf egal — sortiert vergleichen. */
function sortByJson(items: Record<string, unknown>[]): Record<string, unknown>[] {
  return items
    .map((item) => ({ item, key: stableStringify(item) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ item }) => item);
}

/** JSON mit sortierten Schlüsseln — Mongo gibt Objekte nicht in Eingabe-Reihenfolge zurück. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isRecord(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
