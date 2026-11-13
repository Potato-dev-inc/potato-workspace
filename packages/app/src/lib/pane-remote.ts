// An agent's Remote control rule, as the backend keeps it (the bridge enforces it for paired phones), and the
// small rules the card uses to describe a phone: how far it may go on its own, and how far in this agent.
import type { DeviceCap } from '@potato-workspace/shared';

export type PaneRemoteLevel = 'watch' | 'answer' | 'full';
export interface PaneRemote {
  remote: boolean;
  level: PaneRemoteLevel;
}

export const PANE_REMOTE_LEVELS: readonly PaneRemoteLevel[] = ['watch', 'answer', 'full'];
const RANK: Record<PaneRemoteLevel, number> = { watch: 1, answer: 2, full: 3 };

/** How far a phone goes on its own, from its abilities; null when it may not even watch. A phone from an older app has none listed: all of them. */
export function phoneLevel(caps: readonly DeviceCap[] | undefined): PaneRemoteLevel | null {
  if (!caps) return 'full';
  if (caps.includes('type') || caps.includes('control')) return 'full';
  if (caps.includes('answer') && caps.includes('watch')) return 'answer';
  if (caps.includes('watch')) return 'watch';
  return null;
}

/** What the phone may do in this agent: never more than its own level, nothing when the agent is off. */
export function effectiveLevel(rule: PaneRemote, caps: readonly DeviceCap[] | undefined): PaneRemoteLevel | null {
  if (!rule.remote) return null;
  const own = phoneLevel(caps);
  if (!own) return null;
  return RANK[own] <= RANK[rule.level] ? own : rule.level;
}

/** A phone that asks the person on the PC for control of one agent ("<phone> asks for control"). */
export interface ControlAsk {
  id: string;
  device_id: string;
  device_name: string;
  pane_id: string;
  at_ms: number;
}
