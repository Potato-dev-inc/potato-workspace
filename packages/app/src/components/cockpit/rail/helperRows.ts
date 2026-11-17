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

/** An agent whose commands show in a chat's Background tasks: the chat's own agent and every agent started under it. */
export interface CommandOwner {
  id: string;
  /** The name a row says after "by": a minion's task, a spin-off's title, an agent's own name. */
  name: string;
  agentType: string | null;
  status: string;
  /** The chat's own agent. */
  self: boolean;
}

/**
 * The owners whose commands this chat lists (plan 12.1): its own agent, then every agent below it (minions, spin-offs and
 * helpers, and theirs in turn), nearest first. Spin-offs are included here although they have no row of their own.
 */
export function commandOwners<T extends PaneLike>(list: ReadonlyArray<T>, paneId: string, agentNameOf: (pane: T) => string): CommandOwner[] {
  const owner = (p: T, self: boolean): CommandOwner => {
    const agentName = agentNameOf(p);
    const task = p.info.started_as === 'minion' && !p.info.title?.trim() ? taskTitle(p.info.origin?.task) : null;
    const name = task ?? paneHeading(p.info, agentName).primary;
    return { id: p.info.id, name, agentType: p.info.agent_type ?? null, status: p.status, self };
  };
  const me = list.find((p) => p.info.id === paneId);
  const out: CommandOwner[] = me ? [owner(me, true)] : [{ id: paneId, name: '', agentType: null, status: '', self: true }];
  for (const p of list) {
    if (p.info.id === paneId) continue;
    let at: string | null = liveParentId(list, p.info.id);
    for (let hops = 0; at && hops < 16; hops += 1) {
      if (at === paneId) {
        out.push(owner(p, false));
        break;
      }
      at = liveParentId(list, at);
    }
  }
  return out;
}
