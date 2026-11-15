import { Fragment, useState } from 'react';
import { useT } from '../../i18n';
import { isRedBanner, type TeamApi, type TeamState } from '../../lib/team';
import { RedBanners } from '../cockpit/team/RedBanner';
import { TeamCard } from '../cockpit/team/TeamCard';
import { TeamJobCard } from '../cockpit/team/TeamJobCard';
import { TellTeamPrompt } from '../cockpit/team/TellTeam';
import { dayLabel, FEED_FILTERS, feedMatches, type FeedFilter } from './team-page-model';

/** Feed: the heads-up cards that already exist (Inbox shows the ones that need an answer), newest first, by day. */
export function FeedTab({ state, api, now, paneNames, onDone }: { state: TeamState; api: TeamApi; now: number; paneNames?: Map<string, string>; onDone: () => void }) {
  const t = useT();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const cards = state.cards.filter((c) => !isRedBanner(c) && feedMatches(c, filter)).sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const jobs = state.jobs.filter((j) => j.state !== 'discarded');
  const empty = cards.length === 0 && state.drafts.length === 0 && jobs.length === 0;
  let lastDay = '';
  return (
    <div className="tpg-feed">
      <RedBanners state={state} api={api} now={now} onDone={onDone} />
      <div className="tpg-filters" role="group" aria-label={t('teamHub.feed.filters')}>
        {FEED_FILTERS.map((f) => (
          <button key={f} type="button" className="tpg-filter" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {t(`teamHub.feed.${f}` as const)}
          </button>
        ))}
      </div>
      {state.drafts.length > 0 && (
        <ul className="ib-list" aria-label={t('teamHub.feed.unsent')}>
          {state.drafts.map((d) => (
            <li key={d.id} className="ib-surface">
              <TellTeamPrompt draft={d} members={state.members} api={api} variant="row" onDone={onDone} />
            </li>
          ))}
        </ul>
      )}
      {jobs.length > 0 && (
        <ul className="ib-list" aria-label={t('teamHub.feed.updates')}>
          {jobs.map((j) => (
            <li key={j.id}>
              <TeamJobCard job={j} api={api} paneName={j.paneId ? paneNames?.get(j.paneId) : undefined} onDone={onDone} />
            </li>
          ))}
        </ul>
      )}
      {empty && (
        <p className="tpg-sub tpg-empty" data-testid="feed-empty">
          {t('teamHub.feed.empty')}
        </p>
      )}
      {cards.length > 0 && (
        <ul className="ib-list" aria-label={t('teamHub.feed.cards')}>
          {cards.map((card) => {
            const day = dayLabel(card.receivedAtMs, now);
            const head = day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={card.id}>
                {head && (
                  <li className="tpg-day" aria-hidden="true">
                    {day}
                  </li>
                )}
                <li>
                  <TeamCard card={card} api={api} now={now} onDone={onDone} />
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
