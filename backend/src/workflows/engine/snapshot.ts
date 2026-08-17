/**
 * Lesezugriff auf `WorkflowRun.definitionSnapshot` (M-52).
 *
 * Der Snapshot ist im Schema ein `Record<string, unknown>` (Mongo-`Mixed`) und
 * wird beim Start eines Runs aus `WorkflowDefinition.nodes`/`.edges` kopiert.
 * Die Engine hat ihn an sechs Stellen mit
 * `as { nodes: WorkflowNode[]; edges: unknown[] }` behauptet und die Kanten
 * anschließend mit `as never` in den Graph-Walker geschoben — eine Behauptung,
 * die für einen alten oder von außen replizierten Run nicht stimmen muss.
 *
 * Hier entsteht der Graph stattdessen durch echte Prüfungen: jeder Knoten und
 * jede Kante wird aus den Feldern neu aufgebaut, die `WorkflowNode` bzw.
 * `WorkflowEdge` deklarieren. Was strukturell offen ist, bleibt offen
 * (`config`, `inputs`, `outputs`, `ui` sind weiter `Record<string, unknown>`);
 * verengt wird nur, was die Typen ohnehin schon versprechen.
 *
 * Einträge ohne `id`/`type` bzw. ohne `id`/`source`/`target` fallen heraus. Das
 * ist strikt sicherer als vorher: `findTriggerNodes` rief `n.type.startsWith()`
 * auf und wäre an so einem Knoten mit einem TypeError gestorben, der den
 * Worker-Job verschluckt hätte.
 */
import {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodePosition,
} from '../schemas/workflow-definition.schema';
import { asString, isUnknownArray } from '../../common/tool-args';
import { asNumber, asStringArray, asStringRecord, isRecord } from '../workflow-narrow';

/** Knoten + Kanten eines Snapshots, in der Form die `graph-walker` erwartet. */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

function toPosition(value: unknown): WorkflowNodePosition {
  if (!isRecord(value)) return { x: 0, y: 0 };
  return { x: asNumber(value.x) ?? 0, y: asNumber(value.y) ?? 0 };
}

function toOpenRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toNode(value: unknown): WorkflowNode | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const type = asString(value.type);
  if (!id || !type) return undefined;
  return {
    id,
    type,
    label: asString(value.label),
    position: toPosition(value.position),
    config: toOpenRecord(value.config) ?? {},
    secretRefs: asStringArray(value.secretRefs) ?? [],
    inputs: toOpenRecord(value.inputs),
    outputs: toOpenRecord(value.outputs),
    ui: toOpenRecord(value.ui),
  };
}

function toEdge(value: unknown): WorkflowEdge | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const source = asString(value.source);
  const target = asString(value.target);
  if (!id || !source || !target) return undefined;
  // Ein *vorhandener*, aber nicht-stringiger `branch` darf nicht zu `undefined`
  // werden: `graph-walker` liest `edge.branch ?? 'always'`, die Kante würde
  // damit plötzlich immer greifen. Vorher fiel sie durch jeden Vergleich und
  // war praktisch tot — dieselbe Wirkung hat es, sie hier wegzulassen.
  const branch = asString(value.branch);
  if (branch === undefined && value.branch !== undefined && value.branch !== null) {
    return undefined;
  }
  return {
    id,
    source,
    target,
    sourcePort: asString(value.sourcePort),
    targetPort: asString(value.targetPort),
    branch,
    condition: toOpenRecord(value.condition),
    label: asString(value.label),
    ui: toOpenRecord(value.ui),
    payloadMapping: asStringRecord(value.payloadMapping),
  };
}

function readList<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] {
  if (!isUnknownArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    const parsed = read(entry);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** Graph eines `definitionSnapshot`. Fehlt der Snapshot, ist der Graph leer. */
export function readGraph(snapshot: unknown): WorkflowGraph {
  if (!isRecord(snapshot)) return { nodes: [], edges: [] };
  return {
    nodes: readList(snapshot.nodes, toNode),
    edges: readList(snapshot.edges, toEdge),
  };
}
