import { useEffect, useRef } from 'react';
import type { RenderOptions, WhiteboardDoc } from './types';
import { renderWhiteboard, setupHiDpiCanvas } from './engine/Renderer';

interface WhiteboardCanvasProps {
  doc: WhiteboardDoc;
  width?: number;
  height?: number;
  options?: RenderOptions;
  className?: string;
}

export function WhiteboardCanvas({ doc, width = 960, height = 540, options, className }: WhiteboardCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = setupHiDpiCanvas(canvas, width, height);
    let frame = requestAnimationFrame(() => renderWhiteboard(ctx, doc, options));

    return () => cancelAnimationFrame(frame);
  }, [doc, height, options, width]);

  return <canvas ref={canvasRef} className={className} aria-label="Whiteboard canvas" />;
}
