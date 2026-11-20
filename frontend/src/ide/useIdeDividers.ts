import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

type Axis = 'x' | 'y';

/**
 * Pointer-driven divider. `onDrag` receives the pointer delta since the drag began
 * (along `axis`); the owner adds it to the size it had at that moment and clamps in the store.
 */
export function useDivider(axis: Axis, getStart: () => number, onSize: (size: number) => void, invert = false) {
  const drag = useRef<{ pointer: number; start: number } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: axis === 'x' ? event.clientX : event.clientY, start: getStart() };
    },
    [axis, getStart],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (!current) return;
      const delta = (axis === 'x' ? event.clientX : event.clientY) - current.pointer;
      onSize(current.start + (invert ? -delta : delta));
    },
    [axis, invert, onSize],
  );

  const end = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}
