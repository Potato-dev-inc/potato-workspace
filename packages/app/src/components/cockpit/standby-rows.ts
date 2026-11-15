// Where each standby helper is drawn in the sidebar. Pure, no React.
//
// A helper belongs to the project and has a home agent it is shown under (founder design, STANDBY-FLOW section 3):
//   waiting (Ready, Starting, Resting, cannot start) -> under its home agent
//   working for an agent                             -> that agent's own helper row already shows it (the task chat is a pane)
//   working for the person ("With you")              -> under its home agent
//   home agent gone                                  -> under the newest main agent of the same project
//   no main agent in the project                     -> the project's "Helpers waiting for an agent" group
import type { StandbyHelperEntry } from '../../lib/standbyHelpers';
import { liveParentId } from '../../lib/pane-helpers';
import { folderKey } from './history-model';

interface PaneLike {
  info: { id: string; parent_pane_id?: string | null; cwd?: string | null };
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

/** Puts every helper in its place. `panes` is the live pane list in the order the sidebar knows (newest last). */
export function placeHelpers(helpers: readonly StandbyHelperEntry[], panes: ReadonlyArray<PaneLike>): Placement {
  const ids = new Set(panes.map((p) => p.info.id));
  const hiddenPanes = new Set<string>();
  const byAgent = new Map<string, StandbyRow[]>();
  const loose = new Map<string, StandbyRow[]>();
  // Panes that are a helper's own chat never count as agents of the project.
  for (const h of helpers) if (h.open_pane && ids.has(h.open_pane) && h.used_by !== 'agent') hiddenPanes.add(h.open_pane);
  const mains = panes.filter((p) => !hiddenPanes.has(p.info.id) && !liveParentId(panes, p.info.id));
  const newestMainOf = (project: string): string | null => {
    const key = folderKey(project);
    const found = mains.filter((p) => folderKey(p.info.cwd) === key);
    return found.length > 0 ? found[found.length - 1].info.id : null;
  };
  for (const h of helpers) {
    const state = rowState(h);
    // An agent's task: its chat is an ordinary helper row under the agent that asked, which says Working already.
    if (state === 'working' && h.pane_id && ids.has(h.pane_id)) continue;
    const home = h.home && ids.has(h.home) && !hiddenPanes.has(h.home) ? h.home : newestMainOf(h.project);
    const paneId = h.open_pane && ids.has(h.open_pane) ? h.open_pane : h.pane_id && ids.has(h.pane_id) ? h.pane_id : null;
    const row: StandbyRow = { helper: h, state, paneId, under: home };
    const into = home ? byAgent : loose;
    const key = home ?? folderKey(h.project) ?? '';
    into.set(key, [...(into.get(key) ?? []), row]);
  }
  for (const map of [byAgent, loose]) for (const [k, rows] of map) map.set(k, [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state]));
  return { byAgent, loose, hiddenPanes };
}
