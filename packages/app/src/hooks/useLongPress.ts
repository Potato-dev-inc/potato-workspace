// A long press (or the context key, or a right click) on one element: calls `onLong` after `ms` without the finger moving
// far. The tap that ends a long press does nothing else. Used by the phone's message actions.
import { useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';

/** A press this long (milliseconds) counts as a long press. */
export const LONG_PRESS_MS = 500;
/** The finger may drift this far (pixels) before the press is a scroll, not a long press. */
const SLOP_PX = 10;

export function useLongPress(onLong: () => void, ms = LONG_PRESS_MS) {
  const timer = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const end = () => {
    window.clearTimeout(timer.current);
    origin.current = null;
  };
  return {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      end();
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        origin.current = null;
        onLong();
      }, ms);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const from = origin.current;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > SLOP_PX) end();
    },
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
    onContextMenu: (event: ReactMouseEvent) => {
      event.preventDefault();
      end();
      onLong();
    },
  };
}
