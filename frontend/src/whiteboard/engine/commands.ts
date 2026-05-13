import type { Point, SelectionState, WhiteboardDoc, WhiteboardNode } from '../types';

export interface WhiteboardCommand {
  id: string;
  label: string;
  apply(doc: WhiteboardDoc): WhiteboardDoc;
  revert(doc: WhiteboardDoc): WhiteboardDoc;
}

export interface CommandHistory {
  undoStack: WhiteboardCommand[];
  redoStack: WhiteboardCommand[];
  limit: number;
}

export function createCommandHistory(limit = 50): CommandHistory {
  return { undoStack: [], redoStack: [], limit };
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

export function duplicateSelectionCommand(
  doc: WhiteboardDoc,
  selection: SelectionState,
  createId: (prefix: string) => string,
  offset: Point = { x: 24, y: 24 },
): WhiteboardCommand | null {
  const selectedNodes = selection.nodeIds.flatMap((id) => doc.nodes[id] ? [doc.nodes[id]] : []);
  if (selectedNodes.length === 0) return null;

  const idMap = new Map(selectedNodes.map((node) => [node.id, createId(node.type)]));
  const duplicatedNodes = Object.fromEntries(
    selectedNodes.map((node) => {
      const id = idMap.get(node.id)!;
      return [id, duplicateNode(node, id, offset)];
    }),
  );
  const duplicatedEdges = Object.fromEntries(
    Object.values(doc.edges)
      .filter((edge) => idMap.has(edge.fromNodeId) && idMap.has(edge.toNodeId))
      .map((edge) => {
        const id = createId('edge');
        return [id, { ...edge, id, fromNodeId: idMap.get(edge.fromNodeId)!, toNodeId: idMap.get(edge.toNodeId)! }];
      }),
  );

  return {
    id: `duplicate-selection:${selection.nodeIds.join(',')}`,
    label: `Duplicate ${selectedNodes.length} node${selectedNodes.length === 1 ? '' : 's'}`,
    apply: (current) => ({
      ...current,
      nodes: { ...current.nodes, ...duplicatedNodes },
      edges: { ...current.edges, ...duplicatedEdges },
    }),
    revert: (current) => {
      const duplicateNodeIds = new Set(Object.keys(duplicatedNodes));
      const duplicateEdgeIds = new Set(Object.keys(duplicatedEdges));
      return {
        ...current,
        nodes: Object.fromEntries(Object.entries(current.nodes).filter(([id]) => !duplicateNodeIds.has(id))),
        edges: Object.fromEntries(Object.entries(current.edges).filter(([id]) => !duplicateEdgeIds.has(id))),
      };
    },
  };
}


function duplicateNode(node: WhiteboardNode, id: string, offset: Point): WhiteboardNode {
  const shifted = { ...node, id, x: node.x + offset.x, y: node.y + offset.y };
  if (node.type === 'freehand') {
    return {
      ...shifted,
      type: 'freehand',
      points: node.points.map((point) => ({ ...point, x: point.x + offset.x, y: point.y + offset.y })),
    };
  }
  if (node.type === 'arrow') {
    const shiftEndpoint = (value: typeof node.from) => ('nodeId' in value ? value : { x: value.x + offset.x, y: value.y + offset.y });
    return {
      ...shifted,
      type: 'arrow',
      from: shiftEndpoint(node.from),
      to: shiftEndpoint(node.to),
    };
  }
  return shifted;
}

export function applyCommand(doc: WhiteboardDoc, command: WhiteboardCommand): WhiteboardDoc {
  return command.apply(doc);
}

export function pushCommand(history: CommandHistory, command: WhiteboardCommand): CommandHistory {
  return {
    ...history,
    undoStack: [...history.undoStack, command].slice(-history.limit),
    redoStack: [],
  };
}

export function undoCommand(doc: WhiteboardDoc, history: CommandHistory): { doc: WhiteboardDoc; history: CommandHistory } {
  const command = history.undoStack[history.undoStack.length - 1];
  if (!command) return { doc, history };
  return {
    doc: command.revert(doc),
    history: {
      ...history,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, command].slice(-history.limit),
    },
  };
}

export function redoCommand(doc: WhiteboardDoc, history: CommandHistory): { doc: WhiteboardDoc; history: CommandHistory } {
  const command = history.redoStack[history.redoStack.length - 1];
  if (!command) return { doc, history };
  return {
    doc: command.apply(doc),
    history: {
      ...history,
      undoStack: [...history.undoStack, command].slice(-history.limit),
      redoStack: history.redoStack.slice(0, -1),
    },
  };
}
