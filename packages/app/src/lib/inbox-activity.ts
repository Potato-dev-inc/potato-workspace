// "Team activity" on the Inbox: the team's recent events as one short row each (icon colour, line, second line, time).
// Text comes from the same helpers the Team cards use, so teammates' words stay plain text.
import { t } from '../i18n';
import { agentLabel, cleanName, displayName, durationWords, peerLabel, type LendRequest, type LendState } from './lend';
import { cardMeta, cardTitle, isRedBanner, type TeamCard } from './team';

export type ActivityTone = 'pr' | 'push' | 'lend' | 'ok' | 'danger' | 'note';

export interface ActivityRow {
  id: string;
  tone: ActivityTone;
  line: string;
  sub: string;
  atMs: number;
  /** A team card to show in full when "View" is pressed. */
  card?: TeamCard;
  /** A borrow request to answer in place. */
  request?: LendRequest;
}

/** How many rows the Inbox shows before "Open Team". */
export const ACTIVITY_MAX = 5;

export function toneOf(kind: string): ActivityTone {
  if (kind === 'pr_opened' || kind === 'pr_ready' || kind === 'pr_updated' || kind === 'please_review' || kind === 'review_requested') return 'pr';
  if (kind === 'pr_merged' || kind === 'ci_passed') return 'ok';
  if (kind === 'ci_failed') return 'danger';
  if (kind === 'note' || kind === 'pr_closed') return 'note';
  return 'push';
}

export function activityRows(cards: readonly TeamCard[], requests: readonly LendRequest[], lend: LendState | null): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const card of cards) {
    // A red default branch is the banner on top of the Inbox, not a row.
    if (isRedBanner(card) || card.state === 'dismissed') continue;
    rows.push({ id: card.id, tone: toneOf(card.event.kind), line: cardTitle(card.event), sub: cardMeta(card.event), atMs: card.receivedAtMs, card });
  }
  for (const r of requests) {
    rows.push({
      id: `lend:${r.id}`,
      tone: 'lend',
      line: t('inbox.teamBorrow', { who: r.for_other_person ? cleanName(r.member_name) || peerLabel({ peer_name: '', peer_device_name: r.device_name }) : displayName({ device: r.device_name, label: r.member_name }), agent: agentLabel(lend, r.agent_id) }),
      sub: durationWords(r.secs),
      atMs: r.at_ms,
      request: r,
    });
  }
  return rows.sort((a, b) => b.atMs - a.atMs);
}

/** "13:20" today, "Yesterday", else a short date. */
export function whenLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  if (ms >= today.getTime()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (ms >= today.getTime() - 86_400_000) return t('inbox.yesterday');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
