import type { Point, WhiteboardDoc, WhiteboardEdge, WhiteboardNode } from '../types';

const DEFAULT_HIT_TOLERANCE = 6;

export function findNodeAt(point: Point, doc: WhiteboardDoc): WhiteboardNode | null {
  const nodes = Object.values(doc.nodes);
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node && isPointInNode(point, node)) return node;
  }
  return null;
}

export function findEdgeAt(point: Point, doc: WhiteboardDoc, tolerance = DEFAULT_HIT_TOLERANCE): WhiteboardEdge | null {
  const edges = Object.values(doc.edges);
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    const edge = edges[index];
    if (!edge) continue;
    const from = getNodeCenter(doc.nodes[edge.fromNodeId]);
    const to = getNodeCenter(doc.nodes[edge.toNodeId]);
    if (from && to && distanceToSegment(point, from, to) <= tolerance) return edge;
  }
  return null;
}

export function isPointInNode(point: Point, node: WhiteboardNode): boolean {
  if (node.type === 'freehand') {
    const tolerance = Math.max(DEFAULT_HIT_TOLERANCE, (node.strokeWidth ?? 2) + 4);
    return node.points.some((candidate, index, points) => {
      if (index === 0) return distance(point, candidate) <= tolerance;
      return distanceToSegment(point, points[index - 1], candidate) <= tolerance;
    });
  }

  if (node.type === 'arrow') {
    const from = 'nodeId' in node.from ? { x: node.x, y: node.y + node.height / 2 } : node.from;
    const to = 'nodeId' in node.to ? { x: node.x + node.width, y: node.y + node.height / 2 } : node.to;
    return distanceToSegment(point, from, to) <= DEFAULT_HIT_TOLERANCE;
  }

  return point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height;
}

export function getNodeCenter(node: WhiteboardNode | undefined): Point | null {
  if (!node) return null;
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, start);

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}
