import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import type { Point, RenderOptions, ViewportState, WhiteboardDoc } from './types';
import { renderWhiteboard, setupHiDpiCanvas } from './engine/Renderer';
import { panViewport, resetViewport, zoomViewportAt } from './engine/Viewport';

interface WhiteboardCanvasProps {
  doc: WhiteboardDoc;
  width?: number;
  height?: number;
  options?: RenderOptions;
  className?: string;
  onViewportChange?: (viewport: ViewportState) => void;
}

interface DragState {
  pointerId: number;
  lastPoint: Point;
  mode: 'pan';
}

export function WhiteboardCanvas({
  doc,
  width = 960,
  height = 540,
  options,
  className,
  onViewportChange,
}: WhiteboardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [viewport, setViewport] = useState(doc.viewport);
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  useEffect(() => setViewport(doc.viewport), [doc.viewport]);

  const updateViewport = useCallback(
    (next: ViewportState) => {
      setViewport(next);
      onViewportChange?.(next);
    },
    [onViewportChange],
  );

  const renderDoc = useMemo<WhiteboardDoc>(() => ({ ...doc, viewport }), [doc, viewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHiDpiCanvas(canvas, width, height);
    const frame = requestAnimationFrame(() => renderWhiteboard(ctx, renderDoc, options));

    return () => cancelAnimationFrame(frame);
  }, [height, options, renderDoc, width]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setIsSpacePressed(true);
        return;
      }
      if (!canvasRef.current || document.activeElement !== canvasRef.current) return;
      if (event.ctrlKey && event.key === '0') {
        event.preventDefault();
        updateViewport(resetViewport());
      }
      if (event.ctrlKey && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        updateViewport(zoomViewportAt(viewport, { x: width / 2, y: height / 2 }, viewport.zoom * 1.2));
      }
      if (event.ctrlKey && event.key === '-') {
        event.preventDefault();
        updateViewport(zoomViewportAt(viewport, { x: width / 2, y: height / 2 }, viewport.zoom / 1.2));
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setIsSpacePressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [height, updateViewport, viewport, width]);

  const getCanvasPoint = useCallback((event: MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const point = getCanvasPoint(event);
      const nextZoom = viewport.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1);
      updateViewport(zoomViewportAt(viewport, point, nextZoom));
    },
    [getCanvasPoint, updateViewport, viewport],
  );

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      const shouldPan = event.button === 1 || (event.button === 0 && isSpacePressed);
      if (!shouldPan) return;
      event.preventDefault();
      const point = getCanvasPoint(event);
      dragRef.current = { pointerId: event.button, lastPoint: point, mode: 'pan' };
      event.currentTarget.focus();
    },
    [getCanvasPoint, isSpacePressed],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const point = getCanvasPoint(event);
      const delta = { x: point.x - drag.lastPoint.x, y: point.y - drag.lastPoint.y };
      dragRef.current = { ...drag, lastPoint: point };
      updateViewport(panViewport(viewport, delta));
    },
    [getCanvasPoint, updateViewport, viewport],
  );

  const stopDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label="Whiteboard canvas"
      role="img"
      tabIndex={0}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
      style={{ cursor: dragRef.current || isSpacePressed ? 'grab' : undefined }}
    />
  );
}
