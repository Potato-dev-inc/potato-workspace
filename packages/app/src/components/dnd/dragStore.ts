// A small pointer-based drag layer (not HTML5 drag: that is unreliable inside the Tauri window and the file-drop
// listener already owns it). Anything can be a source (`startDrag`) and anything can be a target
// (`registerDropZone`). The first user is "drag a chat from the sidebar into the split view"; tab and project
// reordering can reuse the same two calls.
import { useSyncExternalStore } from "react";

/** What is being dragged. `kind` says what it is ('chat'); zones pick what they accept by kind. */
export interface DragPayload {
  kind: string;
  id: string;
  /** Shown on the ghost card that follows the pointer. */
  label: string;
  /** Extra facts the drop needs (for a file: where it is). */
  meta?: Record<string, string>;
}

export interface DropZone {
  id: string;
  accepts?: (payload: DragPayload) => boolean;
  /** Where the zone is on screen right now. null: not drawn, cannot be hit. */
  getRect: () => {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null;
  /** Where the pointer was when it was released. */
  onDrop: (payload: DragPayload, point: { x: number; y: number }) => void;
  /** When two zones overlap, the higher number wins (default 0). */
  priority?: number;
  /** A thin insertion line to draw while the pointer is over this zone (see `reorder.ts`). null: none. */
  line?: (x: number, y: number) => DropLine | null;
}

/** A line on screen, in window coordinates. */
export interface DropLine {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DragState {
  payload: DragPayload;
  x: number;
  y: number;
  /** The zone under the pointer, if it accepts this payload. */
  over: string | null;
  /** The insertion line of the zone under the pointer, if it draws one. */
  line: DropLine | null;
}

/** The pointer must move this far before a press becomes a drag, so a plain click still clicks. */
export const DRAG_THRESHOLD_PX = 6;

const zones = new Map<string, DropZone>();
const listeners = new Set<() => void>();
let state: DragState | null = null;
let stop: (() => void) | null = null;

// Set when a real drag ends; the click that the release produces is then swallowed. No timer is involved:
// the flag stays set until that click arrives. Any new input (a press, or a key for keyboard and assistive
// clicks) clears it first, so a later click is never lost. The window listeners are installed once.
let swallowNextClick = false;
let clickGuardInstalled = false;

function installClickGuard() {
  if (clickGuardInstalled) return;
  clickGuardInstalled = true;
  const clear = () => {
    swallowNextClick = false;
  };
  window.addEventListener("pointerdown", clear, { capture: true });
  window.addEventListener("keydown", clear, { capture: true });
  window.addEventListener(
    "click",
    (ev) => {
      if (!swallowNextClick) return;
      swallowNextClick = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
    { capture: true },
  );
}

function set(next: DragState | null) {
  state = next;
  for (const l of listeners) l();
}

/** Adds a drop zone; returns the function that removes it. */
export function registerDropZone(zone: DropZone): () => void {
  zones.set(zone.id, zone);
  return () => {
    if (zones.get(zone.id) === zone) zones.delete(zone.id);
  };
}

function zoneAt(payload: DragPayload, x: number, y: number): string | null {
  let best: DropZone | null = null;
  for (const z of zones.values()) {
    if (z.accepts && !z.accepts(payload)) continue;
    const r = z.getRect();
    if (!r || x < r.left || x >= r.right || y < r.top || y >= r.bottom)
      continue;
    if (!best || (z.priority ?? 0) > (best.priority ?? 0)) best = z;
  }
  return best?.id ?? null;
}

function lineAt(over: string | null, x: number, y: number): DropLine | null {
  return (over && zones.get(over)?.line?.(x, y)) || null;
}

/**
 * Starts a drag from a pointer-down event. Nothing happens until the pointer has moved DRAG_THRESHOLD_PX;
 * a release before that leaves the click alone. Esc, losing the window, or a cancelled pointer ends it
 * without a drop. After a real drag the click that follows the release is swallowed.
 */
export function startDrag(
  payload: DragPayload,
  e: { clientX: number; clientY: number; button?: number },
): void {
  if (e.button !== undefined && e.button !== 0) return;
  installClickGuard();
  stop?.();
  const sx = e.clientX;
  const sy = e.clientY;
  let live = false;
  let lx = sx;
  let ly = sy;

  const finish = (drop: boolean) => {
    // Looked up again on release: the zones are only drawn once the drag has started.
    const over = live ? zoneAt(payload, lx, ly) : null;
    cleanup();
    // The release of a real drag is followed by a click on the row; it must not select the chat a second time.
    if (live) swallowNextClick = true;
    set(null);
    if (drop && over) zones.get(over)?.onDrop(payload, { x: lx, y: ly });
  };
  const onMove = (ev: PointerEvent) => {
    if (!live) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX)
        return;
      live = true;
      document.body.classList.add("pm-dragging");
    }
    lx = ev.clientX;
    ly = ev.clientY;
    const over = zoneAt(payload, ev.clientX, ev.clientY);
    set({
      payload,
      x: ev.clientX,
      y: ev.clientY,
      over,
      line: lineAt(over, ev.clientX, ev.clientY),
    });
    // The zones are drawn by this very state change: look again once they exist.
    if (state?.over === null)
      setTimeout(() => {
        if (!state || !stop) return;
        const again = zoneAt(payload, lx, ly);
        set({ ...state, over: again, line: lineAt(again, lx, ly) });
      }, 0);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
    window.removeEventListener("keydown", onKey, true);
    document.body.classList.remove("pm-dragging");
    stop = null;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onCancel);
  window.addEventListener("keydown", onKey, true);
  stop = () => {
    cleanup();
    set(null);
  };
}

/** Ends any drag without a drop (for tests and for a screen that goes away mid-drag). */
export function cancelDrag(): void {
  stop?.();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Whether the pointer is over zone `id` right now. Re-renders only when that changes, not on every move. */
export function useDragOver(id: string): boolean {
  return useSyncExternalStore(subscribe, () => state?.over === id);
}

/** The drag in progress, or null. Re-renders on every pointer move while dragging. */
export function useDrag(): DragState | null {
  return useSyncExternalStore(subscribe, () => state);
}
