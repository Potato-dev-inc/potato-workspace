// The rail's Background tasks rows for helpers: the panes whose live parent is this pane, in list order. A spin-off is
// a chat of its own (a sidebar row), so it has no row here; a minion is a row (`kind: 'minion'`) that opens in the
// details column; any other helper (One type, or from before the kinds) is a row that opens its pane as before.
import { liveParentId, taskTitle } from '../../../lib/pane-helpers';
import { paneHeading } from '../titles';
import type { HelperRow } from './BackgroundSection';

interface PaneLike {
  info: { id: string; title?: string | null; parent_pane_id?: string | null; agent_type?: string; started_as?: string | null; created_at?: number; origin?: { task?: string | null } | null };
  status: string;
}

export function helperRows<T extends PaneLike>(list: ReadonlyArray<T>, paneId: string, agentNameOf: (pane: T) => string): HelperRow[] {
  return list
    .filter((p) => liveParentId(list, p.info.id) === paneId && p.info.started_as !== 'spin_off')
    .map((p) => {
      const agentName = agentNameOf(p);
      const kind: HelperRow['kind'] = p.info.started_as === 'minion' ? 'minion' : 'helper';
      // A minion without a title yet is named by the first words of its task (a helper keeps its agent's name, as before).
      const task = kind === 'minion' && !p.info.title?.trim() ? taskTitle(p.info.origin?.task) : null;
      const heading = task ? { primary: task, secondary: agentName } : paneHeading(p.info, agentName);
      const row: HelperRow = { id: p.info.id, title: heading.primary, agent: heading.secondary, agentType: p.info.agent_type ?? null, status: p.status, kind };
      if (kind === 'minion' && p.info.created_at) row.startedAtMs = p.info.created_at;
      return row;
    });
}
