// The dock: the details column beside a chat's right panel. It is a stack of panes, top to bottom:
//   view     the Background tasks page, or one minion's read-only view
//   terminal one command's output
//   browser  the agent browser (a placeholder until the docked browser lands)
// Opening another view replaces the top one and keeps the rest. Also kept here: whether the column fills the window beside
// the sidebar, whether it is folded to its thin strip, which panes are folded to their header, and which finished rows
// the person cleared. Per chat pane, in memory for this run (the sizes are remembered in `lib/panel-widths`). The rail's
// rows, the chat's "Minion: ..." rows and the column all read this one store, so a click anywhere opens the same view.
import { useSyncExternalStore } from 'react';

export type TaskView = { kind: 'page' } | { kind: 'minion'; id: string };

/** A command an agent left running, as the terminal pane shows it. */
export interface TerminalRef {
  /** The pane that owns the process. */
  owner: string;
  pid: number;
  startedAtMs: number;
  name: string;
  command: string;
  /** A terminal the app hosts for the agent: its output can be read. */
  terminalId?: string;
  /** Opened from the finished list: how it ended. */
  finished?: { state: 'done' | 'failed' | 'stopped'; endedAtMs: number };
}

export type DockPane = TaskView | ({ kind: 'terminal' } & TerminalRef) | { kind: 'browser' };
export type DockSlot = 'view' | 'terminal' | 'browser';
/** The stacking order, top to bottom. */
export const DOCK_SLOTS: readonly DockSlot[] = ['view', 'terminal', 'browser'];

export const slotOf = (pane: DockPane): DockSlot => (pane.kind === 'terminal' ? 'terminal' : pane.kind === 'browser' ? 'browser' : 'view');

export interface TaskViewState {
  /** The open panes in stacking order, at most one per slot. Never empty. */
  panes: readonly DockPane[];
  /** The first pane, kept for callers that only know the top view. */
  view: DockPane;
  /** Fills the window beside the left sidebar: the chat and the right panel step aside. */
  full: boolean;
  /** The whole column is folded to a thin strip of pane icons. The panes stay. */
  collapsed: boolean;
  /** Slots whose pane is folded to its header line. */
  folded: readonly DockSlot[];
}

const byPane = new Map<string, TaskViewState>();
const cleared = new Map<string, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function sorted(panes: readonly DockPane[]): DockPane[] {
  return [...panes].sort((a, b) => DOCK_SLOTS.indexOf(slotOf(a)) - DOCK_SLOTS.indexOf(slotOf(b)));
}

function build(panes: readonly DockPane[], from?: TaskViewState): TaskViewState {
  const list = sorted(panes);
  return { panes: list, view: list[0], full: from?.full ?? false, collapsed: from?.collapsed ?? false, folded: (from?.folded ?? []).filter((s) => list.some((p) => slotOf(p) === s)) };
}

/** Puts a pane in its slot, replacing what was there. Opening the same pane again changes nothing but un-folding it. */
function put(paneId: string, pane: DockPane, opts: { expand: boolean } = { expand: true }): void {
  const was = byPane.get(paneId);
  const slot = slotOf(pane);
  const old = was?.panes.find((p) => slotOf(p) === slot);
  if (was && old && JSON.stringify(old) === JSON.stringify(pane) && !was.folded.includes(slot) && (!was.collapsed || !opts.expand)) return;
  const rest = (was?.panes ?? []).filter((p) => slotOf(p) !== slot);
  const next = build([...rest, pane], was);
  byPane.set(paneId, { ...next, folded: next.folded.filter((s) => s !== slot), collapsed: opts.expand ? false : next.collapsed });
  emit();
}

/** Opens one minion's read-only view in the column. */
export function openMinionView(paneId: string, minionId: string): void {
  put(paneId, { kind: 'minion', id: minionId });
}

/** Opens the full Background tasks page in the column. */
export function openTasksPage(paneId: string): void {
  put(paneId, { kind: 'page' });
}

/** Opens one command's output under the view. */
export function openTerminalView(paneId: string, ref: TerminalRef): void {
  put(paneId, { kind: 'terminal', ...ref });
}

/** Opens the browser pane under the others. A browser opened by an agent does not unfold a folded column. */
export function openBrowserPane(paneId: string, opts?: { expand?: boolean }): void {
  put(paneId, { kind: 'browser' }, { expand: opts?.expand ?? true });
}

/** Closes one pane. The column goes when its last pane does (and so does "fill"). */
export function closeDockPane(paneId: string, slot: DockSlot): void {
  const was = byPane.get(paneId);
  if (!was || !was.panes.some((p) => slotOf(p) === slot)) return;
  const left = was.panes.filter((p) => slotOf(p) !== slot);
  if (left.length === 0) byPane.delete(paneId);
  else byPane.set(paneId, build(left, was));
  emit();
}

/** Closes the whole column. */
export function closeTaskView(paneId: string): void {
  if (byPane.delete(paneId)) emit();
}

export function setTaskFull(paneId: string, full: boolean): void {
  const was = byPane.get(paneId);
  if (!was || was.full === full) return;
  byPane.set(paneId, { ...was, full, collapsed: full ? false : was.collapsed });
  emit();
}

/** Folds the column to its thin strip, or opens it again. The panes stay. */
export function setDockCollapsed(paneId: string, collapsed: boolean): void {
  const was = byPane.get(paneId);
  if (!was || was.collapsed === collapsed) return;
  byPane.set(paneId, { ...was, collapsed, full: collapsed ? false : was.full });
  emit();
}

/** Folds one pane to its header line, or opens it again. The last open pane cannot be folded. */
export function toggleDockFold(paneId: string, slot: DockSlot): void {
  const was = byPane.get(paneId);
  if (!was) return;
  const isFolded = was.folded.includes(slot);
  const open = was.panes.filter((p) => !was.folded.includes(slotOf(p)));
  if (!isFolded && open.length <= 1) return;
  byPane.set(paneId, { ...was, folded: isFolded ? was.folded.filter((s) => s !== slot) : [...was.folded, slot] });
  emit();
}

/** The trash button: the finished rows with these ids leave the list (nothing is stopped or deleted). */
export function clearFinishedTasks(paneId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  cleared.set(paneId, new Set([...(cleared.get(paneId) ?? NONE), ...ids]));
  emit();
}

export function useTaskView(paneId: string): TaskViewState | null {
  return useSyncExternalStore(subscribe, () => byPane.get(paneId) ?? null);
}

export function useClearedTasks(paneId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => cleared.get(paneId) ?? NONE);
}

/** Tests: forget everything. */
export function resetTaskViews(): void {
  byPane.clear();
  cleared.clear();
  emit();
}
