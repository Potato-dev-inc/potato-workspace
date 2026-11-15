// Pure rules of the phone's chat-app shape: which chat the app opens in, who needs you, and how the drawer groups chats.
// No React here, so the rules are tested on their own.
import type { PaneInfo } from '@potato-workspace/shared';
import type { AttentionSnapshot } from '../../lib/attention';
import { glyphStatus, isCompanionPane, projectName } from '../../lib/mobile-agent-tabs';

/** The five states a chat row shows: a dot colour and plain words. */
export type RowState = 'needs' | 'working' | 'risk' | 'broken' | 'idle';

/** The open items on the PC's list that block, by pane. */
function openBlocking(attention: AttentionSnapshot | null) {
  return (attention?.items ?? []).filter((item) => item.state === 'open' && item.lane === 'blocking' && item.pane);
}

/** Panes that wait on the person: at a prompt, failed, or holding an open card on the PC's list. */
export function needsPaneIds(panes: readonly PaneInfo[], attention: AttentionSnapshot | null): Set<string> {
  const ids = new Set<string>();
  for (const pane of panes) if (pane.status === 'waiting_input' || pane.status === 'error') ids.add(pane.id);
  for (const item of openBlocking(attention)) ids.add(item.pane!.id);
  return ids;
}

/** The state of one chat row. A failed pane is "broken"; a risky open card makes "risk"; a prompt is "needs". */
export function rowState(pane: PaneInfo, needs: ReadonlySet<string>, attention: AttentionSnapshot | null): RowState {
  if (pane.status === 'error') return 'broken';
  const risky = openBlocking(attention).some((item) => item.pane!.id === pane.id && (item.risk?.level === 'medium' || item.risk?.level === 'high'));
  if (risky) return 'risk';
  if (needs.has(pane.id)) return 'needs';
  return glyphStatus(pane.status) === 'running' ? 'working' : 'idle';
}

/** When the pane's oldest open card started waiting (epoch ms), or null. The smallest number waited longest. */
function waitingSince(paneId: string, attention: AttentionSnapshot | null): number | null {
  const times = openBlocking(attention)
    .filter((item) => item.pane!.id === paneId && item.since_ms !== null)
    .map((item) => item.since_ms!);
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * The chat the app opens in (D10): the one that needs you (the longest waiting first), else the one read last,
 * else the first. Null when there is no chat at all. `panes` are in tab order and hold no companion panes.
 */
export function pickLanding(panes: readonly PaneInfo[], attention: AttentionSnapshot | null, lastRead: string | null): string | null {
  const agents = panes.filter((pane) => !isCompanionPane(pane.id));
  if (agents.length === 0) return null;
  const needs = needsPaneIds(agents, attention);
  const waiting = agents.filter((pane) => needs.has(pane.id));
  if (waiting.length > 0) {
    // The earliest start has waited longest; a chat with no start time (a prompt on the screen) comes after.
    // A chat that only failed (no card, no prompt) comes after the ones that wait for an answer.
    const ranked = waiting
      .map((pane, order) => ({ pane, since: waitingSince(pane.id, attention) ?? Number.POSITIVE_INFINITY, failed: pane.status === 'error' ? 1 : 0, order }))
      .sort((a, b) => a.failed - b.failed || (a.since === b.since ? a.order - b.order : a.since - b.since));
    return ranked[0]!.pane.id;
  }
  if (lastRead && agents.some((pane) => pane.id === lastRead)) return lastRead;
  return agents[0]!.id;
}

export interface ProjectGroup {
  project: string;
  panes: PaneInfo[];
}

/** Chats that do not wait on you, grouped by project folder in the order each project first appears. */
export function groupByProject(panes: readonly PaneInfo[], needs: ReadonlySet<string>): ProjectGroup[] {
  const groups = new Map<string, PaneInfo[]>();
  for (const pane of panes) {
    if (isCompanionPane(pane.id) || needs.has(pane.id)) continue;
    const project = projectName(pane.cwd);
    groups.set(project, [...(groups.get(project) ?? []), pane]);
  }
  return [...groups].map(([project, list]) => ({ project, panes: list }));
}

/** The number on the menu button: what the PC counts, or (an older PC) the chats that wait. */
export function waitingTotal(panes: readonly PaneInfo[], attention: AttentionSnapshot | null): number {
  if (attention) return attention.counts.blocking;
  return needsPaneIds(panes.filter((pane) => !isCompanionPane(pane.id)), null).size;
}

/** One drawer row: the chat and how far in it sits (0 = the person's own chat, 1 = a helper another agent started under it). */
export interface DrawerRow {
  pane: PaneInfo;
  depth: number;
}

/**
 * The same tree the desktop sidebar shows (`parent_pane_id`): a helper sits right under the chat that started it, one level in.
 * A helper whose parent is not in this list stays on its own. Deeper helpers show at the same single level (a phone is narrow).
 */
export function nestHelpers(panes: readonly PaneInfo[]): DrawerRow[] {
  const byId = new Map(panes.map((p) => [p.id, p] as const));
  const parentOf = (pane: PaneInfo): string | null => {
    const parent = pane.parent_pane_id;
    if (!parent || parent === pane.id || !byId.has(parent)) return null;
    // A loop (a under b under a) keeps both on their own.
    for (let at: string | null | undefined = parent, hops = 0; at; at = byId.get(at)?.parent_pane_id, hops++) {
      if (at === pane.id || hops > panes.length) return null;
    }
    return parent;
  };
  const kids = new Map<string, PaneInfo[]>();
  const roots: PaneInfo[] = [];
  for (const pane of panes) {
    const parent = parentOf(pane);
    if (parent) kids.set(parent, [...(kids.get(parent) ?? []), pane]);
    else roots.push(pane);
  }
  const rows: DrawerRow[] = [];
  const add = (pane: PaneInfo, depth: number, seen: Set<string>) => {
    if (seen.has(pane.id)) return;
    seen.add(pane.id);
    rows.push({ pane, depth });
    for (const child of kids.get(pane.id) ?? []) add(child, 1, seen);
  };
  const seen = new Set<string>();
  for (const root of roots) add(root, 0, seen);
  return rows;
}
