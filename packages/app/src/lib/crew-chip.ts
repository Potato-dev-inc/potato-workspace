// The crew chip at the top of a chat: the agents this chat started (spin-offs you talk to, minions you only watch), as
// counts. Pure, no React. A finished one stays in the list until the chat closes (it is just marked done). Standbys are
// not listed until a task claims one: an unclaimed standby has no parent.
import { t as translate } from '../i18n';
import { liveParentId, taskTitle } from './pane-helpers';

export type CrewKind = 'spin_off' | 'minion';
export type CrewState = 'needs-you' | 'failed' | 'working' | 'done';

export interface CrewMember {
  id: string;
  kind: CrewKind;
  title: string;
  agentType: string | null;
  state: CrewState;
  /** When its pane was created (ms since the epoch). */
  startedAt: number;
}

interface PaneLike {
  info: { id: string; title?: string | null; created_at: number; agent_type?: string; parent_pane_id?: string | null; started_as?: string | null; origin?: { task?: string | null } | null };
  status: string;
}

type Tr = typeof translate;

/** From most to least pressing. A failed one is listed with the ones that need you and never folds away. */
const ORDER: Record<CrewState, number> = { 'needs-you': 0, failed: 1, working: 2, done: 3 };

export function crewState(paneStatus: string, asking: boolean): CrewState {
  if (paneStatus === 'error') return 'failed';
  if (asking || paneStatus === 'waiting_input') return 'needs-you';
  if (paneStatus === 'running') return 'working';
  return 'done';
}

/** The agents whose live parent is `parentId`, in the order the panel lists them. A minion is one started as a minion; any other is a spin-off. */
export function crewMembers<T extends PaneLike>(list: ReadonlyArray<T>, parentId: string, agentNameOf: (pane: T) => string, asking?: ReadonlySet<string>): CrewMember[] {
  return list
    .filter((p) => liveParentId(list, p.info.id) === parentId)
    .map((p): CrewMember => {
      const kind: CrewKind = p.info.started_as === 'minion' ? 'minion' : 'spin_off';
      const own = p.info.title?.trim();
      const title = own || (kind === 'minion' ? taskTitle(p.info.origin?.task) : '') || agentNameOf(p);
      return { id: p.info.id, kind, title, agentType: p.info.agent_type ?? null, state: crewState(p.status, asking?.has(p.info.id) ?? false), startedAt: p.info.created_at };
    })
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export interface CrewCounts {
  total: number;
  spinOffs: number;
  minions: number;
  needsYou: number;
  failed: number;
  working: number;
  done: number;
}

export function crewCounts(members: ReadonlyArray<CrewMember>): CrewCounts {
  const c: CrewCounts = { total: members.length, spinOffs: 0, minions: 0, needsYou: 0, failed: 0, working: 0, done: 0 };
  for (const m of members) {
    if (m.kind === 'minion') c.minions += 1;
    else c.spinOffs += 1;
    if (m.state === 'needs-you') c.needsYou += 1;
    else if (m.state === 'failed') c.failed += 1;
    else if (m.state === 'working') c.working += 1;
    else c.done += 1;
  }
  return c;
}

/** Many agents, or one that needs you or failed: the chip counts by state ("2 need you · 4 working"). */
export const MANY_AGENTS = 6;

export const stateWord = (state: CrewState, t: Tr = translate): string =>
  t(state === 'needs-you' ? 'crew.state.needsYou' : state === 'failed' ? 'crew.state.failed' : state === 'working' ? 'crew.state.working' : 'crew.state.done');

export const kindWord = (kind: CrewKind, t: Tr = translate): string => t(kind === 'minion' ? 'crew.kind.minion' : 'crew.kind.spinOff');

export interface CrewChipView {
  text: string;
  /** What the chip's dot shows: a spinner while any works, the waiting mark when one needs you, nothing when all is finished. */
  tone: 'needs-you' | 'working' | 'quiet';
  /** The only agent, when there is one: the chip then opens it directly. */
  only: CrewMember | null;
}

/** The chip's words, or null when this chat started nothing. */
export function crewChipView(members: ReadonlyArray<CrewMember>, t: Tr = translate): CrewChipView | null {
  if (members.length === 0) return null;
  const c = crewCounts(members);
  const tone: CrewChipView['tone'] = c.needsYou + c.failed > 0 ? 'needs-you' : c.working > 0 ? 'working' : 'quiet';
  if (members.length === 1) {
    const m = members[0]!;
    return { text: t('crew.chip.one', { kind: kindWord(m.kind, t), title: m.title, state: stateWord(m.state, t) }), tone, only: m };
  }
  if (c.done === c.total) return { text: t('crew.n.done', { count: c.done }), tone: 'quiet', only: null };
  const parts: string[] = [];
  if (c.needsYou + c.failed > 0 || c.total >= MANY_AGENTS) {
    if (c.needsYou) parts.push(t('crew.n.needYou', { count: c.needsYou }));
    if (c.failed) parts.push(t('crew.n.failed', { count: c.failed }));
    if (c.working) parts.push(t('crew.n.working', { count: c.working }));
    if (c.done) parts.push(t('crew.n.done', { count: c.done }));
  } else {
    if (c.spinOffs) parts.push(t('crew.n.spinOffs', { count: c.spinOffs }));
    if (c.minions) parts.push(t('crew.n.minions', { count: c.minions }));
  }
  return { text: parts.join(' · '), tone, only: null };
}

export interface CrewGroup {
  kind: CrewKind;
  members: CrewMember[];
}

/** Finished rows fold into one line once there are more than this many in a group. Failed ones never fold. */
export const FOLD_DONE_OVER = 2;

/** The panel's groups: spin-offs first, then minions; an empty group is left out. */
export function crewGroups(members: ReadonlyArray<CrewMember>): CrewGroup[] {
  return (['spin_off', 'minion'] as const).map((kind) => ({ kind, members: members.filter((m) => m.kind === kind) })).filter((g) => g.members.length > 0);
}

/** The rows a group shows: all of them, or with `fold` the done ones left out (the panel says how many). */
export function visibleRows(group: CrewGroup, expanded: boolean): { rows: CrewMember[]; folded: number } {
  const done = group.members.filter((m) => m.state === 'done');
  if (expanded || done.length <= FOLD_DONE_OVER) return { rows: group.members, folded: 0 };
  return { rows: group.members.filter((m) => m.state !== 'done'), folded: done.length };
}
