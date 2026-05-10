import type { Point, SelectionState, WhiteboardDoc, WhiteboardNode } from '../types';

export interface WhiteboardCommand {
  id: string;
  label: string;
  apply(doc: WhiteboardDoc): WhiteboardDoc;
  revert(doc: WhiteboardDoc): WhiteboardDoc;
}

export function createNodeCommand(node: WhiteboardNode, label = `Create ${node.type}`): WhiteboardCommand {
  return {
    id: `create-node:${node.id}`,
    label,
    apply: (doc) => ({
      ...doc,
      nodes: { ...doc.nodes, [node.id]: node },
    }),
    revert: (doc) => {
      const { [node.id]: _removed, ...nodes } = doc.nodes;
      return { ...doc, nodes };
    },
  };
}

export function updateNodeCommand(before: WhiteboardNode, after: WhiteboardNode, label = `Update ${after.type}`): WhiteboardCommand {
  return {
    id: `update-node:${after.id}`,
    label,
    apply: (doc) => ({
      ...doc,
      nodes: { ...doc.nodes, [after.id]: after },
    }),
    revert: (doc) => ({
      ...doc,
      nodes: { ...doc.nodes, [before.id]: before },
    }),
  };
}

export function moveNodesCommand(nodes: WhiteboardNode[], delta: Point): WhiteboardCommand {
  const before = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const after = Object.fromEntries(nodes.map((node) => [node.id, { ...node, x: node.x + delta.x, y: node.y + delta.y }]));

  return {
    id: `move-nodes:${nodes.map((node) => node.id).join(',')}`,
    label: `Move ${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
    apply: (doc) => ({
      ...doc,
      nodes: { ...doc.nodes, ...after },
    }),
    revert: (doc) => ({
      ...doc,
      nodes: { ...doc.nodes, ...before },
    }),
  };
}

export function deleteSelectionCommand(doc: WhiteboardDoc, selection: SelectionState): WhiteboardCommand | null {
  const removedNodes = Object.fromEntries(selection.nodeIds.flatMap((id) => doc.nodes[id] ? [[id, doc.nodes[id]]] : []));
  const removedEdges = Object.fromEntries(selection.edgeIds.flatMap((id) => doc.edges[id] ? [[id, doc.edges[id]]] : []));
  const removedNodeIds = new Set(Object.keys(removedNodes));

  if (Object.keys(removedNodes).length === 0 && Object.keys(removedEdges).length === 0) return null;

  return {
    id: `delete-selection:${[...selection.nodeIds, ...selection.edgeIds].join(',')}`,
    label: 'Delete selection',
    apply: (current) => {
      const nodes = Object.fromEntries(Object.entries(current.nodes).filter(([id]) => !removedNodeIds.has(id)));
      const edges = Object.fromEntries(
        Object.entries(current.edges).filter(([id, edge]) => {
          if (removedEdges[id]) return false;
          return !removedNodeIds.has(edge.fromNodeId) && !removedNodeIds.has(edge.toNodeId);
        }),
      );
      return { ...current, nodes, edges };
    },
    revert: (current) => ({
      ...current,
      nodes: { ...current.nodes, ...removedNodes },
      edges: { ...current.edges, ...removedEdges },
    }),
  };
}

export function applyCommand(doc: WhiteboardDoc, command: WhiteboardCommand): WhiteboardDoc {
  return command.apply(doc);
}
