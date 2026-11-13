// Files dragged in from Windows Explorer. The desktop app reports a drop for the whole window, with the pointer in
// window pixels, so there must be exactly ONE listener: places that take files (the chat box, the sidebar, a
// terminal pane) register a target with their rectangle and the listener hands the paths to the one under the pointer.
// The listener is installed with the first target and removed with the last. Outside the desktop app nothing runs.
import { inDesktop } from './attachFiles';

export interface FileDropTarget {
  /** Unique among the targets. */
  id: string;
  /** Where the target is on screen now (window pixels / devicePixelRatio, like getBoundingClientRect). null: not drawn. */
  getRect: () => { left: number; right: number; top: number; bottom: number } | null;
  onDrop: (paths: string[]) => void;
  /** The pointer is over this target with files (true), or left it (false). */
  onOver?: (over: boolean) => void;
  /** When targets overlap, the higher number wins; then the one registered last. Default 0. */
  priority?: number;
}

/** What the window reports (a subset of Tauri's drag-drop event payload). */
export type WindowDropEvent =
  | { type: 'enter' | 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

/** Starts listening; resolves to the function that stops. */
export type DropSource = (cb: (e: WindowDropEvent) => void) => Promise<() => void>;

const tauriSource: DropSource = async (cb) => {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((event) => cb(event.payload as WindowDropEvent));
};

const targets = new Map<string, FileDropTarget>();
let source: DropSource | null = null;
let stop: (() => void) | null = null;
let installing = false;
let over: string | null = null;

function targetAt(x: number, y: number): FileDropTarget | null {
  const scale = window.devicePixelRatio || 1;
  const px = x / scale;
  const py = y / scale;
  let best: FileDropTarget | null = null;
  for (const t of targets.values()) {
    const r = t.getRect();
    if (!r || px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
    if (!best || (t.priority ?? 0) >= (best.priority ?? 0)) best = t;
  }
  return best;
}

function setOver(next: string | null) {
  if (next === over) return;
  if (over) targets.get(over)?.onOver?.(false);
  over = next;
  if (over) targets.get(over)?.onOver?.(true);
}

function handle(e: WindowDropEvent) {
  if (e.type === 'leave') return setOver(null);
  const hit = targetAt(e.position.x, e.position.y);
  if (e.type === 'drop') {
    setOver(null);
    if (hit && e.paths.length > 0) hit.onDrop(e.paths);
    return;
  }
  setOver(hit?.id ?? null);
}

function install() {
  if (stop || installing || targets.size === 0) return;
  const start = source ?? (inDesktop() ? tauriSource : null);
  if (!start) return;
  installing = true;
  start(handle).then(
    (off) => {
      installing = false;
      if (targets.size === 0) off();
      else stop = off;
    },
    () => {
      installing = false;
    },
  );
}

/** Adds a target; returns the function that removes it. */
export function registerFileDrop(target: FileDropTarget): () => void {
  targets.set(target.id, target);
  install();
  return () => {
    if (targets.get(target.id) !== target) return;
    targets.delete(target.id);
    if (over === target.id) over = null;
    if (targets.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** For tests: replace the window event source (null: the real one). Removes the current listener. */
export function setFileDropSource(next: DropSource | null): void {
  stop?.();
  stop = null;
  source = next;
  over = null;
  install();
}
