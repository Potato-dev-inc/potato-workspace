// Inbox > Working now: who is working this minute, on which step, for how long. Pure, no React.
// These rows are calm on purpose: they are not "Needs you" items, never add to its number and never notify.
import { activityText, type ActivityMap } from './pane-activity';

/** Rows shown before "Show all". */
export const WORKING_SHOWN = 5;

export interface WorkingRow {
  paneId: string;
  agent: string;
  /** The live step ("Running npm test"), or null when the agent has not said. */
  step: string | null;
  /** Epoch ms since when it has been working, or null when unknown. */
  since: number | null;
}

interface PaneLike {
  info: { id: string; agent_type: string };
  status: string;
}

/**
 * The panes that are running now, longest first. Left out: companions (a companion is not a chat), a pane that has
 * its own stuck card (it needs you, so it sits above) and anything not running (a waiting pane has a card too).
 */
export function workingRows(
  panes: ReadonlyArray<PaneLike>,
  opts: { activities?: ActivityMap; statusSince: ReadonlyMap<string, number>; skip: (paneId: string) => boolean },
): WorkingRow[] {
  const rows: WorkingRow[] = [];
  for (const p of panes) {
    if (p.status !== 'running' || opts.skip(p.info.id)) continue;
    rows.push({ paneId: p.info.id, agent: p.info.agent_type, step: activityText(p.status, opts.activities?.[p.info.id]), since: opts.statusSince.get(p.info.id) ?? null });
  }
  return rows.sort((a, b) => (a.since ?? Number.MAX_SAFE_INTEGER) - (b.since ?? Number.MAX_SAFE_INTEGER) || a.paneId.localeCompare(b.paneId));
}
