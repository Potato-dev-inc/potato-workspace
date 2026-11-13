// Desktop Potato: turning what the app already knows into pet events. Pure.
import type { AttentionSnapshot } from '../../lib/attention';
import { inQuietHours, type QuietHours } from '../../lib/notify-levels';
import type { PetNeed } from './petModel';

/** A plain name for an agent id when no definition gives one ("claude_code" becomes "Claude code"). */
export function plainAgentName(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ') : 'Agent';
}

/**
 * The open items that block on the person, as pet needs. Only items tied to a chat or terminal pane count (the
 * bubble must be able to open that agent). `nameOf` gives the agent's label from its id.
 */
export function needsFromSnapshot(snapshot: AttentionSnapshot | null, nameOf: (agentId: string) => string): PetNeed[] {
  if (!snapshot) return [];
  const out: PetNeed[] = [];
  for (const item of snapshot.items) {
    if (item.state !== 'open' || item.lane !== 'blocking' || !item.pane) continue;
    const agent = item.pane.agent ? nameOf(item.pane.agent) : item.pane.heading || plainAgentName('');
    out.push({ key: item.key, paneId: item.pane.id, agent });
  }
  return out;
}

export interface PaneLite {
  id: string;
  agent_type: string;
  status: string;
}

/**
 * A pane that was running and is now idle has finished a run. Returns the finished pane (and the updated map of last
 * known statuses), or null for any other change. Companion panes and panes seen for the first time never count.
 */
export function finishedRun(
  known: Map<string, string>,
  event: { pane_id: string; status: string },
  paneOf: (id: string) => PaneLite | undefined,
): PaneLite | null {
  const before = known.get(event.pane_id);
  known.set(event.pane_id, event.status);
  if (before !== 'running' || event.status !== 'idle') return null;
  if (event.pane_id.startsWith('companion-')) return null;
  return paneOf(event.pane_id) ?? { id: event.pane_id, agent_type: '', status: event.status };
}

/** Quiet for the pet: the person's Quiet choice, or the notification quiet hours (the same ones as alerts). */
export function petIsQuiet(choice: boolean, quiet: QuietHours, now: Date): boolean {
  return choice || inQuietHours(now.getHours() * 60 + now.getMinutes(), quiet);
}
