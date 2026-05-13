import type { Point, RenderOptions, WhiteboardDoc, WhiteboardEdge, WhiteboardNode } from '../types';
import { getNodeCenter } from './hitTest';

const DEFAULT_NODE_FILL = '#111827';
const DEFAULT_NODE_STROKE = '#334155';
const DEFAULT_TEXT = '#e5e7eb';
const DEFAULT_ACCENT = '#22d3ee';

export function setupHiDpiCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context is unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function renderWhiteboard(ctx: CanvasRenderingContext2D, doc: WhiteboardDoc, options: RenderOptions = {}): void {
  const canvas = ctx.canvas;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  ctx.save();
  ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
  ctx.fillStyle = options.background ?? '#020617';
  ctx.fillRect(0, 0, width, height);

  ctx.translate(doc.viewport.x, doc.viewport.y);
  ctx.scale(doc.viewport.zoom, doc.viewport.zoom);

  if (options.showGrid ?? true) drawGrid(ctx, doc.viewport.x, doc.viewport.y, doc.viewport.zoom, width, height);

  Object.values(doc.edges).forEach((edge) => drawEdge(ctx, doc, edge));
  Object.values(doc.nodes).forEach((node) => drawNode(ctx, node));
  if (options.draftNode) drawNode(ctx, options.draftNode);

  if (options.selection) {
    options.selection.nodeIds.forEach((id) => {
      const node = doc.nodes[id];
      if (node) drawSelection(ctx, node);
    });
  }

  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, viewportX: number, viewportY: number, zoom: number, screenWidth: number, screenHeight: number): void {
  const step = 32;
  const worldLeft = -viewportX / zoom;
  const worldTop = -viewportY / zoom;
  const worldRight = worldLeft + screenWidth / zoom;
  const worldBottom = worldTop + screenHeight / zoom;
  const startX = Math.floor(worldLeft / step) * step;
  const endX = Math.ceil(worldRight / step) * step;
  const startY = Math.floor(worldTop / step) * step;
  const endY = Math.ceil(worldBottom / step) * step;

  ctx.save();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth = 1 / zoom;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += step) {
    ctx.moveTo(x, startY);
    ctx.lineTo(x, endY);
  }
  for (let y = startY; y <= endY; y += step) {
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  if (node.type === 'freehand') return drawFreehand(ctx, node.points, node.style?.stroke ?? DEFAULT_ACCENT, node.strokeWidth ?? 2);
  if (node.type === 'arrow') return drawArrow(ctx, resolveArrowPoint(node.from, { x: node.x, y: node.y }), resolveArrowPoint(node.to, { x: node.x + node.width, y: node.y + node.height }), node.style?.stroke ?? DEFAULT_ACCENT);

  const radius = node.type === 'schema' ? 10 : 8;
  ctx.save();
  ctx.globalAlpha = node.style?.opacity ?? 1;
  roundedRect(ctx, node.x, node.y, node.width, node.height, radius);
  ctx.fillStyle = node.style?.fill ?? DEFAULT_NODE_FILL;
  ctx.strokeStyle = node.style?.stroke ?? (node.type === 'schema' ? DEFAULT_ACCENT : DEFAULT_NODE_STROKE);
  ctx.lineWidth = node.style?.strokeWidth ?? 1.5;
  ctx.fill();
  ctx.stroke();

  const label = node.type === 'text' ? node.text : node.type === 'rect' ? node.text : node.type === 'schema' ? (node.title ?? node.schemaId) : '';
  if (label) drawLabel(ctx, label, node.x + 12, node.y + 24, node.width - 24, node.style?.textColor ?? DEFAULT_TEXT);
  ctx.restore();
}

function drawEdge(ctx: CanvasRenderingContext2D, doc: WhiteboardDoc, edge: WhiteboardEdge): void {
  const from = getNodeCenter(doc.nodes[edge.fromNodeId]);
  const to = getNodeCenter(doc.nodes[edge.toNodeId]);
  if (!from || !to) return;
  drawArrow(ctx, from, to, edge.style?.stroke ?? '#94a3b8', edge.style?.strokeWidth ?? 1.5, edge.style?.dashed);
}

function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, stroke: string, width = 2, dashed = false): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = 10;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = width;
  if (dashed) ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawFreehand(ctx: CanvasRenderingContext2D, points: Point[], stroke: string, width: number): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.stroke();
  ctx.restore();
}

function drawSelection(ctx: CanvasRenderingContext2D, node: WhiteboardNode): void {
  ctx.save();
  ctx.strokeStyle = DEFAULT_ACCENT;
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(node.x - 4, node.y - 4, node.width + 8, node.height + 8);
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, color: string): void {
  ctx.fillStyle = color;
  ctx.font = '14px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y, maxWidth);
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

function resolveArrowPoint(value: { nodeId: string; anchor?: string } | Point, fallback: Point): Point {
  return 'nodeId' in value ? fallback : value;
}
