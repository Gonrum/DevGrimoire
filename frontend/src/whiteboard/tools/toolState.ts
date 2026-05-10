import type { Point, RectNode, SelectionState, TextNode, WhiteboardDoc, WhiteboardNode } from '../types';
import { findNodeAt } from '../engine/hitTest';
import { createNodeCommand, moveNodesCommand, type WhiteboardCommand } from '../engine/commands';
import { panViewport } from '../engine/Viewport';

export type WhiteboardTool = 'select' | 'pan' | 'rect' | 'text' | 'arrow';

export type ToolMode = 'idle' | 'dragging' | 'panning' | 'drawing' | 'editing';

export interface ToolState {
  tool: WhiteboardTool;
  mode: ToolMode;
  start?: Point;
  current?: Point;
  targetNodeId?: string;
}

export interface WhiteboardInteractionState {
  doc: WhiteboardDoc;
  selection: SelectionState;
  toolState: ToolState;
}

export interface PointerModifiers {
  shiftKey?: boolean;
}

export interface PointerResult {
  state: WhiteboardInteractionState;
  command?: WhiteboardCommand;
}

export type CreateId = (prefix: string) => string;

export function createInitialInteractionState(doc: WhiteboardDoc, tool: WhiteboardTool = 'select'): WhiteboardInteractionState {
  return {
    doc,
    selection: { nodeIds: [], edgeIds: [] },
    toolState: { tool, mode: 'idle' },
  };
}

export function setTool(state: WhiteboardInteractionState, tool: WhiteboardTool): WhiteboardInteractionState {
  return {
    ...state,
    toolState: { tool, mode: 'idle' },
  };
}

export function toolFromShortcut(key: string): WhiteboardTool | null {
  switch (key.toLowerCase()) {
    case 'v':
      return 'select';
    case 'h':
      return 'pan';
    case 'r':
      return 'rect';
    case 't':
      return 'text';
    case 'a':
      return 'arrow';
    default:
      return null;
  }
}

export function cancelToolAction(state: WhiteboardInteractionState): WhiteboardInteractionState {
  return {
    ...state,
    toolState: { tool: state.toolState.tool, mode: 'idle' },
  };
}

export function handlePointerDown(state: WhiteboardInteractionState, point: Point, modifiers: PointerModifiers = {}): WhiteboardInteractionState {
  const { tool } = state.toolState;

  if (tool === 'pan') {
    return { ...state, toolState: { tool, mode: 'panning', start: point, current: point } };
  }

  if (tool === 'select') {
    const node = findNodeAt(point, state.doc);
    const selection = selectNode(state.selection, node, Boolean(modifiers.shiftKey));
    return {
      ...state,
      selection,
      toolState: { tool, mode: node ? 'dragging' : 'idle', start: point, current: point, targetNodeId: node?.id },
    };
  }

  if (tool === 'text') {
    return { ...state, toolState: { tool, mode: 'editing', start: point, current: point } };
  }

  return { ...state, toolState: { tool, mode: 'drawing', start: point, current: point } };
}

export function handlePointerMove(state: WhiteboardInteractionState, point: Point): WhiteboardInteractionState {
  const { toolState } = state;
  if (!toolState.start) return state;

  if (toolState.tool === 'pan' && toolState.mode === 'panning' && toolState.current) {
    const delta = { x: point.x - toolState.current.x, y: point.y - toolState.current.y };
    return {
      ...state,
      doc: { ...state.doc, viewport: panViewport(state.doc.viewport, delta) },
      toolState: { ...toolState, current: point },
    };
  }

  return { ...state, toolState: { ...toolState, current: point } };
}

export function handlePointerUp(state: WhiteboardInteractionState, point: Point, createId: CreateId = defaultCreateId): PointerResult {
  const { toolState } = state;
  const start = toolState.start;
  if (!start) return { state: cancelToolAction(state) };

  if (toolState.tool === 'select' && toolState.mode === 'dragging') {
    const selectedNodes = state.selection.nodeIds.flatMap((id) => state.doc.nodes[id] ? [state.doc.nodes[id]] : []);
    const delta = { x: point.x - start.x, y: point.y - start.y };
    if (selectedNodes.length > 0 && (delta.x !== 0 || delta.y !== 0)) {
      const command = moveNodesCommand(selectedNodes, delta);
      return { state: { ...cancelToolAction(state), doc: command.apply(state.doc) }, command };
    }
  }

  if (toolState.tool === 'rect' && toolState.mode === 'drawing') {
    const node = createRectNode(createId('rect'), start, point);
    if (node.width > 2 && node.height > 2) return applyCreatedNode(state, node, 'Create rectangle');
  }

  if (toolState.tool === 'text' && toolState.mode === 'editing') {
    const node = createTextNode(createId('text'), point);
    return applyCreatedNode(state, node, 'Create text');
  }

  if (toolState.tool === 'arrow' && toolState.mode === 'drawing') {
    const node = createArrowNode(createId('arrow'), start, point);
    if (node.width > 2 || node.height > 2) return applyCreatedNode(state, node, 'Create arrow');
  }

  return { state: cancelToolAction(state) };
}

function applyCreatedNode(state: WhiteboardInteractionState, node: WhiteboardNode, label: string): PointerResult {
  const command = createNodeCommand(node, label);
  return {
    state: {
      ...cancelToolAction(state),
      doc: command.apply(state.doc),
      selection: { nodeIds: [node.id], edgeIds: [] },
    },
    command,
  };
}

function selectNode(selection: SelectionState, node: WhiteboardNode | null, additive: boolean): SelectionState {
  if (!node) return additive ? selection : { nodeIds: [], edgeIds: [] };
  if (!additive) return { nodeIds: [node.id], edgeIds: [] };
  const exists = selection.nodeIds.includes(node.id);
  return {
    nodeIds: exists ? selection.nodeIds.filter((id) => id !== node.id) : [...selection.nodeIds, node.id],
    edgeIds: [],
  };
}

function createRectNode(id: string, start: Point, end: Point): RectNode {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    id,
    type: 'rect',
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function createTextNode(id: string, point: Point): TextNode {
  return {
    id,
    type: 'text',
    x: point.x,
    y: point.y,
    width: 220,
    height: 64,
    text: 'Text',
  };
}

function createArrowNode(id: string, start: Point, end: Point): WhiteboardNode {
  return {
    id,
    type: 'arrow',
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
    from: start,
    to: end,
  };
}

function defaultCreateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
