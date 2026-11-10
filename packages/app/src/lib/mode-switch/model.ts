// The animated Orchestration <-> Individual switch: the pure rules. Nothing here touches the DOM or Tauri.
// The motions are the ones in docs/plans/mode-switch-animation.html (options D "Domino" and E "Ink").
//
// All rectangles that travel between Rust, the cockpit and the overlay are in PHYSICAL SCREEN pixels
// (`Rect`). Only the overlay turns them into CSS pixels of its own monitor (`toLocal`).

export type Rect = { x: number; y: number; w: number; h: number };
export type Monitor = { x: number; y: number; w: number; h: number; scale: number };

/** What Settings stores (`mode_switch_animation`). */
export type SwitchStyle = 'domino' | 'ink' | 'off';
/** What actually plays. `fade` is "Off" and reduced motion: a short crossfade, nothing moves. */
export type MotionStyle = 'domino' | 'ink' | 'fade';
export type Direction = 'individual' | 'orchestration';

/** What Settings stores (`individual_window_layout`): where the pop-outs go on the switch to Individual. */
export type WindowLayoutChoice = 'side_by_side' | 'cascade';
export const DEFAULT_WINDOW_LAYOUT: WindowLayoutChoice = 'side_by_side';
export const WINDOW_LAYOUTS: WindowLayoutChoice[] = ['side_by_side', 'cascade'];
export const WINDOW_LAYOUT_LABELS: Record<WindowLayoutChoice, string> = { side_by_side: 'Side by side', cascade: 'Cascade' };

export function parseWindowLayout(value: unknown): WindowLayoutChoice {
  return value === 'side_by_side' || value === 'cascade' ? value : DEFAULT_WINDOW_LAYOUT;
}

export const DEFAULT_STYLE: SwitchStyle = 'domino';
export const STYLE_LABELS: Record<SwitchStyle, string> = { domino: 'Domino', ink: 'Ink', off: 'Off' };

/** The active pane plus the next 7 animate; the rest just appear. */
export const MAX_ANIMATED = 8;
export const DOMINO_MS = 530;
export const INK_MS = 720;
export const FADE_MS = 120;
export const STEP_MS = 80;
export const STEP_CAP_MS = 240;
/** Ink: the dot every pane shrinks to (CSS px). */
export const SEED_PX = 30;
/** Rust waits this long past the animation for the overlay before it finishes the switch itself. */
export const HARD_TIMEOUT_SLACK_MS = 150;
export const WINDOW_RADIUS_PX = 7;

export function parseSwitchStyle(value: unknown): SwitchStyle {
  return value === 'domino' || value === 'ink' || value === 'off' ? value : DEFAULT_STYLE;
}

/** The motion for a setting. Reduced motion (Windows animation effects off, or prefers-reduced-motion) always fades. */
export function motionFor(style: SwitchStyle, reducedMotion: boolean): MotionStyle {
  if (reducedMotion || style === 'off') return 'fade';
  return style;
}

/** Windows animation effects off, or the browser's prefers-reduced-motion. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Animation order: the active pane first, then the other open panes, then the sidebar-only ones. */
export function orderPanes(ids: readonly string[], activeId: string | null, openIds: ReadonlySet<string>): string[] {
  const unique = [...new Set(ids)];
  const active = unique.filter((id) => id === activeId);
  const open = unique.filter((id) => id !== activeId && openIds.has(id));
  const rest = unique.filter((id) => id !== activeId && !openIds.has(id));
  return [...active, ...open, ...rest];
}

/**
 * The order Rust lays the Individual windows out in (top-left first): the active pane, then the panes open in the
 * cockpit grid in grid order, then the sidebar-only panes in sidebar order. Repeats are dropped.
 */
export function layoutOrder(activeId: string | null, gridIds: readonly string[], sidebarIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of [...(activeId ? [activeId] : []), ...gridIds, ...sidebarIds]) if (!out.includes(id)) out.push(id);
  return out;
}

/** The first `MAX_ANIMATED` animate; the others only appear. */
export function splitAnimated<T>(ordered: readonly T[]): { animated: T[]; instant: T[] } {
  return { animated: ordered.slice(0, MAX_ANIMATED), instant: ordered.slice(MAX_ANIMATED) };
}

/** Domino: `min(index*80, 240)` ms; on the way back the order is reversed, `min((n-1-index)*80, 240)`. */
export function staggerMs(index: number, count: number, reverse: boolean): number {
  const step = reverse ? count - 1 - index : index;
  return Math.min(Math.max(step, 0) * STEP_MS, STEP_CAP_MS);
}

/** Domino tilt at the halfway keyframe: the active pane (-2deg), every other pane 8deg. */
export function dominoTilt(index: number): number {
  return index === 0 ? -2 : 8;
}

export interface Timing {
  duration: number;
  delay: number;
  easing: string;
}

export function timing(motion: MotionStyle, index: number, count: number, reverse: boolean): Timing {
  if (motion === 'ink') return { duration: INK_MS, delay: 0, easing: 'ease-in-out' };
  if (motion === 'domino') return { duration: DOMINO_MS, delay: staggerMs(index, count, reverse), easing: 'ease-in-out' };
  return { duration: FADE_MS, delay: 0, easing: 'ease-out' };
}

/** The motion's length as the overlay itself works it out from what it was asked to draw (never from `totalMs`). */
export function expectedMs(spec: Pick<RunSpec, 'motion' | 'proxies'>): number {
  return totalMs(spec.motion, spec.proxies.length);
}

/**
 * How much longer the overlay waits before it says "done", when every animation reports finished `elapsedMs` after
 * it started although the motion lasts `expected` ms. 0 when it really ran its time.
 */
export function holdMs(expected: number, elapsedMs: number): number {
  if (!Number.isFinite(expected) || expected <= 0) return 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.max(0, Math.round(expected - elapsed));
}

/** When the last proxy has landed. Rust adds `HARD_TIMEOUT_SLACK_MS` and then finishes the switch itself. */
export function totalMs(motion: MotionStyle, count: number): number {
  if (count <= 0) return 0;
  let longest = 0;
  for (let i = 0; i < count; i++) {
    const t = timing(motion, i, count, false);
    longest = Math.max(longest, t.delay + t.duration);
  }
  return longest;
}

type Box = { left: number; top: number; width: number; height: number };

/** CSS pixels of the overlay's monitor from physical screen pixels. */
export function toLocal(rect: Rect, monitor: Monitor): Box {
  const s = monitor.scale > 0 ? monitor.scale : 1;
  return { left: (rect.x - monitor.x) / s, top: (rect.y - monitor.y) / s, width: rect.w / s, height: rect.h / s };
}

const px = (b: Box) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
const mid = (a: Box, b: Box, f: number): Box => ({
  left: a.left + (b.left - a.left) * f,
  top: a.top + (b.top - a.top) * f,
  width: a.width + (b.width - a.width) * f,
  height: a.height + (b.height - a.height) * f,
});
/** A `n` px square centred on the box. */
export const seed = (b: Box, n: number): Box => ({ left: b.left + b.width / 2 - n / 2, top: b.top + b.height / 2 - n / 2, width: n, height: n });

export type Frame = Record<string, string | number>;

/**
 * Keyframes of one proxy from `a` (its start: tile or sidebar row) to `b` (its pop-out window), both in CSS px.
 * Proxies animate left/top/width/height (and rotate for Domino), never `scale`, so text never stretches.
 * The way back plays the same frames with `direction: reverse`.
 */
export function keyframes(motion: MotionStyle, a: Box, b: Box, index: number): Frame[] {
  if (motion === 'ink') {
    return [
      { ...px(a), borderRadius: `${WINDOW_RADIUS_PX}px`, offset: 0 },
      { ...px(seed(a, SEED_PX)), borderRadius: '50%', offset: 0.27 },
      { ...px(seed(b, SEED_PX)), borderRadius: '50%', offset: 0.68 },
      { ...px(b), borderRadius: `${WINDOW_RADIUS_PX}px`, offset: 1 },
    ];
  }
  if (motion === 'domino') {
    const tilt = dominoTilt(index);
    return [
      { ...px(a), transform: 'rotate(0deg)', offset: 0 },
      { ...px(mid(a, b, 0.5)), transform: `rotate(${tilt}deg)`, offset: 0.5 },
      { ...px(b), transform: 'rotate(0deg)', offset: 1 },
    ];
  }
  // fade: the window face sits at its destination and only its opacity changes.
  return [
    { ...px(b), opacity: 0, offset: 0 },
    { ...px(b), opacity: 1, offset: 1 },
  ];
}

/** What the overlay tells Rust about the proxies it is about to draw: id and the from/to boxes in its own CSS px. */
export function proxyReport(spec: Pick<RunSpec, 'proxies' | 'monitor'>): Array<{ id: string; from: number[]; to: number[] }> {
  const flat = (b: Box) => [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 10) / 10);
  return spec.proxies.map((p) => ({ id: p.id.slice(0, 12), from: flat(toLocal(p.start, spec.monitor)), to: flat(toLocal(p.end, spec.monitor)) }));
}

/** Is any part of `r` on `monitor`? A pane whose window lands on another monitor only appears. */
export function onMonitor(r: Rect, monitor: Monitor): boolean {
  return r.x < monitor.x + monitor.w && r.x + r.w > monitor.x && r.y < monitor.y + monitor.h && r.y + r.h > monitor.y;
}

export type SourceKind = 'tile' | 'row' | 'header' | 'edge';

/**
 * Where a pane's proxy starts when going to Individual (and ends when coming back), by priority:
 *  1. its open grid tile;
 *  2. its sidebar row;
 *  3. if the project is folded (no row), the project header row;
 *  4. a row or header scrolled out of the sidebar list: the nearest top or bottom edge of the list.
 * Rects are in the same space (any, as long as all agree). `null`: nothing to start from, the window only appears.
 */
export function pickSource(input: { tile: Rect | null; row: Rect | null; header: Rect | null; list: Rect | null }): { rect: Rect; kind: SourceKind } | null {
  if (input.tile) return { rect: input.tile, kind: 'tile' };
  const candidate = input.row ?? input.header;
  if (!candidate) return null;
  const kind: SourceKind = input.row ? 'row' : 'header';
  const list = input.list;
  if (!list) return { rect: candidate, kind };
  const mid = candidate.y + candidate.h / 2;
  const inView = candidate.y >= list.y - 0.5 && candidate.y + candidate.h <= list.y + list.h + 0.5;
  if (inView) return { rect: candidate, kind };
  // Scrolled out: stick to the nearest edge of the list, keeping the row's own height.
  const h = Math.min(candidate.h, list.h);
  const top = mid < list.y + list.h / 2;
  return { rect: { x: list.x, y: top ? list.y : list.y + list.h - h, w: list.w, h }, kind: 'edge' };
}

/** Simplified face of a proxy; a snapshot is the tile's own pixels. */
export type Face =
  | { kind: 'snapshot'; src: string }
  | { kind: 'simple'; name: string; project: string; status: string };

export interface ProxySpec {
  id: string;
  /** Tile or sidebar row (or the sidebar edge). Physical screen px. */
  start: Rect;
  /** The pop-out window. Physical screen px. */
  end: Rect;
  face: Face;
  /** Starts as a sidebar row: the row face crossfades into the window face as it grows. */
  fromRow: boolean;
}

export interface RunSpec {
  gen: number;
  direction: Direction;
  motion: MotionStyle;
  monitor: Monitor;
  proxies: ProxySpec[];
  /** The mini bar's rect: it fades in at the end (going to Individual) or out first (coming back). */
  miniBar: Rect | null;
  totalMs: number;
}

/** Row face fades out over the first part of the flight and the window face fades in (spec: 50% of the time, from 15%). */
export function faceFade(duration: number, delay: number, reverse: boolean): { duration: number; delay: number } {
  return { duration: duration * 0.5, delay: delay + duration * (reverse ? 0.5 : 0.15) };
}
