import type { PointerEvent as ReactPointerEvent } from 'react';
import { startDrag, type DragPayload } from './dragStore';

/** Props for an element that can be dragged: spread them on it. A plain click still clicks (6 px threshold). */
export function dragSourceProps(payload: DragPayload): { onPointerDown: (e: ReactPointerEvent) => void } {
  return { onPointerDown: (e) => startDrag(payload, e) };
}
