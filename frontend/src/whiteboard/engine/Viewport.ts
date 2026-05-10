import type { Point, ViewportState } from '../types';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(point: Point, viewport: ViewportState): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

export function screenToWorld(point: Point, viewport: ViewportState): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

export function panViewport(viewport: ViewportState, delta: Point): ViewportState {
  return {
    ...viewport,
    x: viewport.x + delta.x,
    y: viewport.y + delta.y,
  };
}

export function zoomViewportAt(viewport: ViewportState, screenPoint: Point, nextZoom: number): ViewportState {
  const zoom = clampZoom(nextZoom);
  const before = screenToWorld(screenPoint, viewport);

  return {
    zoom,
    x: screenPoint.x - before.x * zoom,
    y: screenPoint.y - before.y * zoom,
  };
}

export function resetViewport(): ViewportState {
  return { x: 0, y: 0, zoom: 1 };
}
