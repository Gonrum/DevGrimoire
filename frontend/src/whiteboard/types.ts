export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export interface WhiteboardDoc {
  version: 1;
  nodes: Record<string, WhiteboardNode>;
  edges: Record<string, WhiteboardEdge>;
  viewport: ViewportState;
}

export type WhiteboardNode = RectNode | TextNode | SchemaNode | ArrowNode | FreehandNode;

export interface BaseNode extends Point, Size {
  id: string;
  type: WhiteboardNode['type'];
  rotation?: number;
  style?: NodeStyle;
  locked?: boolean;
}

export interface RectNode extends BaseNode {
  type: 'rect';
  text?: string;
}

export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: string;
}

export interface SchemaNode extends BaseNode {
  type: 'schema';
  schemaId: string;
  title?: string;
  fields?: Array<{ id: string; name: string; type?: string; primaryKey?: boolean; indexed?: boolean }>;
  collapsed?: boolean;
}

export interface ArrowNode extends BaseNode {
  type: 'arrow';
  from: AnchorRef | Point;
  to: AnchorRef | Point;
  label?: string;
}

export interface FreehandNode extends BaseNode {
  type: 'freehand';
  points: Array<Point & { pressure?: number }>;
  strokeWidth?: number;
}

export interface WhiteboardEdge {
  id: string;
  fromNodeId: string;
  fromAnchor?: string;
  toNodeId: string;
  toAnchor?: string;
  label?: string;
  style?: EdgeStyle;
}

export interface AnchorRef {
  nodeId: string;
  anchor?: string;
}

export interface NodeStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  textColor?: string;
}

export interface EdgeStyle {
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  arrowStart?: boolean;
  arrowEnd?: boolean;
}

export interface SelectionState {
  nodeIds: string[];
  edgeIds: string[];
}

export interface RenderOptions {
  showGrid?: boolean;
  selection?: SelectionState;
  background?: string;
  draftNode?: WhiteboardNode;
}

export const EMPTY_WHITEBOARD_DOC: WhiteboardDoc = {
  version: 1,
  nodes: {},
  edges: {},
  viewport: { x: 0, y: 0, zoom: 1 },
};
