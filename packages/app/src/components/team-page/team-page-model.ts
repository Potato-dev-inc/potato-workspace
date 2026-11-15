// The Team page's pure rules: who is here, in what order people show, the words for each state, what waits for me.
import { t } from '../../i18n';
import { DEFAULT_SHARE, type MemberView, type PresenceView, type ShareLevel, type ShareView, type TeamCard, type TeamConfigView, type TeamState } from '../../lib/team';
import type { LendState } from '../../lib/lend';

export type TeamTab = 'people' | 'usage' | 'tasks' | 'shelf' | 'feed' | 'setup';
export const TABS: readonly TeamTab[] = ['people', 'usage', 'tasks', 'shelf', 'feed', 'setup'];

/** A state older than this reads as "not here" (the Rust side beats every 60 s). */
export const STALE_MS = 180_000;

export type PresenceKind = 'here' | 'away' | 'gone';

/** A person's presence now. No entry, or one older than three minutes: gone. */
export function presenceKindOf(p: PresenceView | undefined, now: number): PresenceKind {
  if (!p || p.state === 'gone') return 'gone';
  if (now - p.atMs > STALE_MS) return 'gone';
  return p.state;
}

const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** "Here" / "Away · 12 min" / "Not here · last seen 09:40" / "Not here". */
export function presenceWords(p: PresenceView | undefined, now: number): string {
  const kind = presenceKindOf(p, now);
  if (kind === 'here') return t('teamHub.presence.here');
  if (kind === 'away') return t('teamHub.presence.away', { minutes: Math.max(1, Math.round((now - (p?.sinceMs ?? now)) / 60_000)) });
  if (p && p.atMs > 0) return t('teamHub.presence.lastSeen', { time: clock(p.atMs) });
  return t('teamHub.presence.notHere');
}

export interface Person {
  member: MemberView;
  presence: PresenceView | undefined;
  kind: PresenceKind;
}

const RANK: Record<PresenceKind, number> = { here: 0, away: 1, gone: 2 };

/** Me first, then here, away, not here; by name inside each group. I am always listed as here. */
export function sortPeople(members: readonly MemberView[], presence: readonly PresenceView[], now: number): Person[] {
  const people = members.map<Person>((member) => {
    const p = presence.find((x) => x.member === member.id);
    return { member, presence: p, kind: member.me ? 'here' : presenceKindOf(p, now) };
  });
  return people.sort((a, b) => {
    if (a.member.me !== b.member.me) return a.member.me ? -1 : 1;
    return RANK[a.kind] - RANK[b.kind] || a.member.name.localeCompare(b.member.name);
  });
}

export const hereCount = (people: readonly Person[]): number => people.filter((p) => p.kind === 'here').length;

/** "Working on potato-workspace", with the title when that person shares it. Null when nothing is shared. */
export function workingLine(p: PresenceView | undefined): string | null {
  if (!p) return null;
  const project = p.project?.trim() || null;
  const title = p.title?.trim() || null;
  if (project && title) return t('teamHub.working.both', { project, title });
  if (project) return t('teamHub.working.project', { project });
  if (title) return t('teamHub.working.title', { title });
  return null;
}

/** "2 agents running · 1 agent waits for an answer", or null. */
export function busyLine(p: PresenceView | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.running > 0) parts.push(t('teamHub.busy.running', { count: p.running }));
  if (p.waiting > 0) parts.push(t('teamHub.busy.waiting', { count: p.waiting }));
  return parts.length ? parts.join(' · ') : null;
}

/** The link line under the team name. */
export function linkWords(state: Pick<TeamState, 'transport' | 'link' | 'enabled'> | null): string {
  if (!state || !state.enabled) return t('teamHub.link.paused');
  if (state.transport === 'folder') return t('teamHub.link.folder');
  switch (state.link) {
    case 'live':
      return t('teamHub.link.live');
    case 'polling':
      return t('teamHub.link.polling');
    case 'offline':
      return t('teamHub.link.offline');
    case 'denied':
      return t('teamHub.link.denied');
    default:
      return t('teamHub.link.connecting');
  }
}

/** What I share, from the backend; an older backend means the default (here only). */
export const shareOf = (state: Pick<TeamState, 'share'> | null): ShareView => state?.share ?? DEFAULT_SHARE;

/** The "Others see:" line for a share level. */
export function shareLine(level: ShareLevel): string {
  return t(`teamHub.share.line.${level}` as const);
}

/** Cards that wait for me in Tasks: a review request or a note, still new. */
export function tasksForMe(cards: readonly TeamCard[]): TeamCard[] {
  return cards.filter((c) => c.state === 'new' && (c.event.kind === 'please_review' || c.event.kind === 'review_requested' || c.event.kind === 'note'));
}

export interface TabCounts {
  people: number;
  usage: number;
  tasks: number;
  shelf: number;
  feed: number;
  setup: number;
}

/** The numbers on the tabs: only things waiting for me (a join request for an admin, a lend ask, a task). */
export function tabCounts(state: TeamState | null, config: TeamConfigView | null, lend: LendState | null): TabCounts {
  const joins = config?.admin ? config.joins.length : 0;
  const asks = lend?.requests_in.filter((r) => r.state === 'open').length ?? 0;
  return { people: joins, usage: asks, tasks: tasksForMe(state?.cards ?? []).length, shelf: 0, feed: 0, setup: 0 };
}

/** The number on the sidebar row: join requests (admin) and lend asks. */
export function sidebarCount(config: Pick<TeamConfigView, 'admin' | 'joins'> | null, lend: LendState | null): number {
  return (config?.admin ? config.joins.length : 0) + (lend?.requests_in.filter((r) => r.state === 'open').length ?? 0);
}

/** Feed filters. */
export type FeedFilter = 'all' | 'needs' | 'prs' | 'pushes' | 'ci';
export const FEED_FILTERS: readonly FeedFilter[] = ['all', 'needs', 'prs', 'pushes', 'ci'];

export function feedMatches(card: TeamCard, filter: FeedFilter): boolean {
  const k = card.event.kind;
  switch (filter) {
    case 'all':
      return true;
    case 'needs':
      return card.state === 'new';
    case 'prs':
      return k.startsWith('pr_') || k === 'please_review' || k === 'review_requested';
    case 'pushes':
      return k === 'pushed';
    case 'ci':
      return k === 'ci_failed' || k === 'ci_passed';
  }
}

/** "Today", "Yesterday" or a date. */
export function dayLabel(ms: number, now: number): string {
  const day = (v: number) => new Date(v).setHours(0, 0, 0, 0);
  const diff = Math.round((day(now) - day(ms)) / 86_400_000);
  if (diff <= 0) return t('teamHub.feed.today');
  if (diff === 1) return t('teamHub.feed.yesterday');
  return new Date(ms).toLocaleDateString();
}
