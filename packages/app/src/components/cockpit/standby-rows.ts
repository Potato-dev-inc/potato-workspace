// Where each standby helper is drawn in the sidebar. Pure, no React.
//
// A standby is a SEAT under its home agent (the founder's rule): one row that never moves. A task changes the row's state
// (Ready -> Working -> Ready) and nothing else: no new row appears, the row is never drawn anywhere else, and the chat the
// task runs in is this row's chat, never an agent of its own.
//   every state (Ready, Working, With you, Starting, Resting, cannot start) -> under its home agent
//   home agent gone (was set, now closed)           -> under the newest main agent of the same project
//   never had a home (made from the crew sheet or Settings: nobody started it) -> the project's own "Standbys" group
//   no main agent in the project                     -> the same "Standbys" group
import { standbyKindOf, type StandbyHelperEntry } from '../../lib/standbyHelpers';
import { liveParentId } from '../../lib/pane-helpers';
import { folderKey } from './history-model';

interface PaneLike {
  info: { id: string; parent_pane_id?: string | null; cwd?: string | null; standby_seat?: string | null };
  status: string;
}

export type StandbyRowState = 'ready' | 'working' | 'withYou' | 'starting' | 'resting' | 'problem';

export interface StandbyRow {
  helper: StandbyHelperEntry;
  state: StandbyRowState;
  /** The chat to open on a click (the person's open chat, or the task's chat). `null`: opening it makes one. */
  paneId: string | null;
  /** The agent the row hangs under (`null`: the project's loose group). */
  under: string | null;
}

export interface Placement {
  /** Rows by the pane they hang under. */
  byAgent: Map<string, StandbyRow[]>;
  /** Rows no agent can hold, by project folder key. */
  loose: Map<string, StandbyRow[]>;
  /** Panes that are a helper's own chat (drawn as the helper's row, never as an agent). */
  hiddenPanes: Set<string>;
  /** Free warm agents: removed from their agent and still running. They are drawn on the quiet line at the bottom of the sidebar. */
  warm: StandbyRow[];
  /** Ready standbys set to "minion": no sidebar row. They show as "N ready" in their agent's Background tasks, by the pane they
   * belong to (the same home rule as a row). */
  readyMinions: Map<string, number>;
}

/** A standby with no sidebar row: set to "minion" while the app runs two types of started agents (otherwise the kind is ignored). */
export const isMinionStandby = (h: StandbyHelperEntry, twoTypes: boolean): boolean => twoTypes && standbyKindOf(h) === 'minion';

/** How many minion standbys are ready for agent `paneId`. Same home rule as the rows (its own, else the newest agent of the project). */
export function readyMinionCount(helpers: readonly StandbyHelperEntry[], panes: ReadonlyArray<PaneLike>, paneId: string, twoTypes: boolean): number {
  return placeHelpers(helpers, panes, new Set(), twoTypes).readyMinions.get(paneId) ?? 0;
}

export function rowState(h: StandbyHelperEntry): StandbyRowState {
  switch (h.state) {
    case 'ready':
      return 'ready';
    case 'busy':
      return h.used_by === 'person' ? 'withYou' : 'working';
    case 'starting':
      return 'starting';
    case 'asleep':
      return 'resting';
    default:
      return 'problem';
  }
}

const ORDER: Record<StandbyRowState, number> = { working: 0, withYou: 1, ready: 2, starting: 3, resting: 4, problem: 5 };

/** Puts every helper in its place. `panes` is the live pane list in the order the sidebar knows (newest last). `opening`: chats
 * that appeared while a helper was being opened: they are the helper's own chat (its row says so as soon as the list is read
 * again), so they never show as an agent in the meantime. */
export function placeHelpers(helpers: readonly StandbyHelperEntry[], panes: ReadonlyArray<PaneLike>, opening: ReadonlySet<string> = new Set(), twoTypes = true): Placement {
  const readyMinions = new Map<string, number>();
  const spinOffs = helpers.filter((h) => !isMinionStandby(h, twoTypes));
  const ids = new Set(panes.map((p) => p.info.id));
  const hiddenPanes = new Set<string>(opening);
  const byAgent = new Map<string, StandbyRow[]>();
  const loose = new Map<string, StandbyRow[]>();
  const warm: StandbyRow[] = [];
  // Panes that are a seat's own chat never count as agents: the chat the person opened on it, the chat its task runs in, and
  // (a finished task chat is an ordinary chat again: the pane list stops flagging it). The pane list itself says which seat a chat belongs to
  // (`standby_seat`), so a task's chat is hidden from the first moment it is listed, before the helper list is read again.
  const seats = new Set(spinOffs.map((h) => h.id));
  const seatPane = new Map<string, string>();
  for (const p of panes) {
    const seat = p.info.standby_seat;
    if (!seat || !seats.has(seat)) continue;
    hiddenPanes.add(p.info.id);
    seatPane.set(seat, p.info.id);
  }
  for (const h of spinOffs) {
    for (const id of [h.open_pane, h.pane_id]) if (id && ids.has(id)) hiddenPanes.add(id);
  }
  const mains = panes.filter((p) => !hiddenPanes.has(p.info.id) && !liveParentId(panes, p.info.id));
  const newestMainOf = (project: string): string | null => {
    const key = folderKey(project);
    const found = mains.filter((p) => folderKey(p.info.cwd) === key);
    return found.length > 0 ? found[found.length - 1].info.id : null;
  };
  // A minion standby is never a row. A ready one is counted under its agent; one a task has taken is a minion pane (hidden elsewhere).
  for (const h of helpers) {
    if (!isMinionStandby(h, twoTypes) || h.state !== 'ready') continue;
    const home = h.home && ids.has(h.home) && !hiddenPanes.has(h.home) ? h.home : newestMainOf(h.project);
    if (home) readyMinions.set(home, (readyMinions.get(home) ?? 0) + 1);
  }
  for (const h of spinOffs) {
    // The seat's chat right now: the task's chat, else the one the person opened, else a chat the pane list says is this
    // seat's (the helper list is a moment behind).
    const flagged = seatPane.get(h.id);
    const live = h.pane_id && ids.has(h.pane_id) ? h.pane_id : h.open_pane && ids.has(h.open_pane) ? h.open_pane : flagged ?? null;
    // A task's chat is listed before the helper list says "busy": the row says Working from that moment.
    // (A chat that is idle is a finished one the list has not dropped yet: the row stays Ready.)
    const taskListed = !!live && live !== h.open_pane && panes.some((p) => p.info.id === live && !!p.info.parent_pane_id && p.status === 'running');
    const state: StandbyRowState = h.state === 'ready' && taskListed ? 'working' : rowState(h);
    // A standby that was never put under an agent is nobody's helper: it waits in the project's own group.
    const home = h.home && ids.has(h.home) && !hiddenPanes.has(h.home) ? h.home : h.home ? newestMainOf(h.project) : null;
    const paneId = live;
    if (h.warm) {
      warm.push({ helper: h, state, paneId, under: null });
      continue;
    }
    const row: StandbyRow = { helper: h, state, paneId, under: home };
    const into = home ? byAgent : loose;
    const key = home ?? folderKey(h.project) ?? '';
    into.set(key, [...(into.get(key) ?? []), row]);
  }
  for (const map of [byAgent, loose]) for (const [k, rows] of map) map.set(k, [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state]));
  return { byAgent, loose, hiddenPanes, warm: warm.sort((a, b) => ORDER[a.state] - ORDER[b.state]), readyMinions };
}
