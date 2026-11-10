// Cockpit side of the animated switch: find where each pane's proxy starts (its tile, its sidebar row, the folded
// project header or the sidebar edge) and what it looks like. Reads the DOM only; never changes layout, so no
// pane's terminal grid is touched.
import {
  MAX_ANIMATED,
  onMonitor,
  layoutOrder,
  orderPanes,
  pickSource,
  splitAnimated,
  type Face,
  type Monitor,
  type ProxySpec,
  type Rect,
} from './model';
import type { WindowRect } from './protocol';

export interface PaneLabel {
  name: string;
  project: string;
  status: string;
}

export interface CollectInput {
  root: ParentNode;
  /** Panes that get a window (from Rust), with that window's rect. */
  windows: readonly WindowRect[];
  /** The pane on show in the cockpit (animates first). */
  activeId: string | null;
  /** Physical screen px of the cockpit's client-area top-left. */
  origin: { x: number; y: number };
  /** Device pixels per CSS pixel of the cockpit's window. */
  dpr: number;
  monitor: Monitor;
  describe: (id: string) => PaneLabel;
  /** Take a snapshot of an open tile (going to Individual only). */
  snapshots?: boolean;
}

const esc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

/** A DOM rect as physical screen px. */
export function screenRect(r: { left: number; top: number; width: number; height: number }, origin: { x: number; y: number }, dpr: number): Rect {
  return { x: origin.x + r.left * dpr, y: origin.y + r.top * dpr, w: r.width * dpr, h: r.height * dpr };
}

function visibleRect(node: Element | null): DOMRect | null {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/** The nearest ancestor that scrolls vertically (the sidebar list). */
function scrollParent(node: Element | null): Element | null {
  for (let cur = node?.parentElement ?? null; cur; cur = cur.parentElement) {
    const overflow = getComputedStyle(cur).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return cur;
  }
  return null;
}

/** Panes whose tile is in the grid right now. */
export function openTileIds(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll<HTMLElement>('[data-pane-tile]').forEach((n) => {
    const id = n.dataset.paneTile;
    if (id && visibleRect(n)) out.add(id);
  });
  return out;
}

/** The layout order of the panes on screen now (see `layoutOrder`): the open tiles and the sidebar rows, in DOM order. */
export function readPaneOrder(root: ParentNode, activeId: string | null): string[] {
  const grid = [...root.querySelectorAll<HTMLElement>('[data-pane-tile]')].filter((n) => visibleRect(n)).map((n) => n.dataset.paneTile ?? '').filter(Boolean);
  const rows = [...root.querySelectorAll<HTMLElement>('[data-pane-row]')].map((n) => n.dataset.paneRow ?? '').filter(Boolean);
  return layoutOrder(activeId, grid, rows);
}

/** Copy the tile's terminal canvas pixels (a plain clone of a canvas renders blank). Null when there is no canvas. */
export function snapshotTile(tile: Element, dpr: number): string | null {
  try {
    const box = tile.getBoundingClientRect();
    const canvases = [...tile.querySelectorAll('canvas')].filter((c) => c.width > 0 && c.height > 0);
    if (!canvases.length || box.width <= 0 || box.height <= 0) return null;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(box.width * dpr));
    out.height = Math.max(1, Math.round(box.height * dpr));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = getComputedStyle(tile).backgroundColor || '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      ctx.drawImage(c, (r.left - box.left) * dpr, (r.top - box.top) * dpr, r.width * dpr, r.height * dpr);
    }
    return out.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/** The start rect of one pane, in physical screen px, and where it came from. */
export function sourceFor(root: ParentNode, id: string, origin: { x: number; y: number }, dpr: number) {
  const tile = root.querySelector(`[data-pane-tile="${esc(id)}"]`);
  const row = root.querySelector(`[data-pane-row="${esc(id)}"]`);
  const group = [...root.querySelectorAll<HTMLElement>('[data-pane-ids]')].find((g) => (g.dataset.paneIds ?? '').split(' ').includes(id));
  const header = group?.querySelector('.ck-proj-head') ?? null;
  const listEl = scrollParent(row ?? header) ?? root.querySelector('.ck-side-scroll');
  const conv = (r: DOMRect | null): Rect | null => (r ? screenRect(r, origin, dpr) : null);
  const picked = pickSource({
    tile: conv(visibleRect(tile)),
    row: conv(visibleRect(row)),
    header: conv(visibleRect(header)),
    list: conv(visibleRect(listEl)),
  });
  return picked ? { ...picked, tile } : null;
}

/** The proxies of the (at most 8) panes that animate, active pane first. Panes with no start or whose window is off the monitor only appear. */
export function collectProxies(input: CollectInput): ProxySpec[] {
  const winOf = new Map(input.windows.map((w) => [w.id, w.rect]));
  const open = openTileIds(input.root);
  const ordered = orderPanes(
    input.windows.map((w) => w.id),
    input.activeId,
    open,
  );
  const { animated } = splitAnimated(ordered);
  const out: ProxySpec[] = [];
  for (const id of animated.slice(0, MAX_ANIMATED)) {
    const end = winOf.get(id);
    if (!end || !onMonitor(end, input.monitor)) continue;
    const src = sourceFor(input.root, id, input.origin, input.dpr);
    if (!src || !onMonitor(src.rect, input.monitor)) continue;
    const label = input.describe(id);
    let face: Face = { kind: 'simple', name: label.name, project: label.project, status: label.status };
    if (input.snapshots && src.kind === 'tile' && src.tile) {
      const snap = snapshotTile(src.tile, input.dpr);
      if (snap) face = { kind: 'snapshot', src: snap };
    }
    out.push({ id, start: src.rect, end, face, fromRow: src.kind !== 'tile' });
  }
  return out;
}
