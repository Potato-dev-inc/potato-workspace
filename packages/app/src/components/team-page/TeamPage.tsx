import { useState } from 'react';
import { InviteSheet } from './InviteSheet';
import { useT } from '../../i18n';
import type { LendApi } from '../../lib/lend';
import { teamApi, type InviteView, type TeamApi, type TeamConfigView, type TeamState } from '../../lib/team';
import type { LendHandle } from '../lend/useLend';
import { FeedTab } from './FeedTab';
import { inviteSlot } from './invite-slot';
import { PeopleTab } from './PeopleTab';
import { SetupTab } from './SetupTab';
import { ShelfTab } from './ShelfTab';
import { TasksTab } from './TasksTab';
import { hereCount, linkWords, shareOf, sortPeople, tabCounts, TABS, type TeamTab } from './team-page-model';
import { UsageTab } from './UsageTab';

// The tab is remembered for the session (not saved to disk): coming back to Team shows the one you were on.
let rememberedTab: TeamTab = 'people';
export const resetRememberedTab = (): void => {
  rememberedTab = 'people';
};

/** Header (team name, link line, counts, Invite) and the six tabs. */
export function TeamPage({
  state,
  config,
  lend,
  api = teamApi,
  lendClient,
  now,
  paneNames,
  displayName,
  onRefresh,
}: {
  state: TeamState;
  config: TeamConfigView;
  lend: LendHandle;
  api?: TeamApi;
  lendClient?: LendApi;
  now: number;
  paneNames?: Map<string, string>;
  displayName?: string;
  onRefresh: () => void;
}) {
  const t = useT();
  const [tab, setTabState] = useState<TeamTab>(rememberedTab);
  const setTab = (next: TeamTab) => {
    rememberedTab = next;
    setTabState(next);
  };
  const [invite, setInvite] = useState<(InviteView & { joinUrl: string }) | null>(null);
  const people = sortPeople(config.members, state.presence ?? [], now);
  const counts = tabCounts(state, config, lend.state);

  return (
    <div className="tpg" data-testid="team-page">
      <header className="tpg-head">
        <div className="tpg-head-main">
          <h1 className="tpg-title">{config.teamName || t('teamHub.title.fallback')}</h1>
          <p className="tpg-link" data-testid="team-link">
            <span className="tpg-link-dot" data-link={state.link ?? 'none'} aria-hidden="true" />
            {linkWords(state)}
          </p>
          <p className="tpg-sub">{t('teamHub.head.counts', { count: people.length, here: hereCount(people) })}</p>
          {state.missing > 0 && (
            <p className="tpg-sub" role="status">
              {t('teamHub.missing', { count: state.missing })}{' '}
              <button type="button" className="tpg-link-btn" onClick={() => void api.clearGaps().finally(onRefresh)}>
                {t('teamHub.missing.show')}
              </button>
            </p>
          )}
        </div>
        {config.admin && (
          <button type="button" className="ck-btn ck-btn--secondary" data-testid="team-invite" onClick={() => void inviteSlot({ api, show: setInvite, openSetup: () => setTab('setup') })}>
            {t('teamHub.invite')}
          </button>
        )}
      </header>
      {invite && <InviteSheet invite={invite} api={api} onNew={setInvite} onClose={() => setInvite(null)} />}
      <div className="tpg-tabs" role="tablist" aria-label={t('teamHub.tabs')}>
        {TABS.map((id) => (
          <button key={id} type="button" role="tab" id={`tpg-tab-${id}`} aria-selected={tab === id} aria-controls="tpg-panel" className="tpg-tab" data-testid={`tab-${id}`} onClick={() => setTab(id)}>
            {t(`teamHub.tab.${id}` as const)}
            {counts[id] > 0 && <span className="tpg-count">{counts[id]}</span>}
          </button>
        ))}
      </div>
      <div className="tpg-panel" role="tabpanel" id="tpg-panel" aria-labelledby={`tpg-tab-${tab}`}>
        {tab === 'people' && <PeopleTab people={people} config={config} share={shareOf(state)} api={api} now={now} lendOn={lend.enabled} onAskUsage={() => setTab('usage')} onChanged={onRefresh} />}
        {tab === 'usage' && <UsageTab lend={lend} api={lendClient} team={api} />}
        {tab === 'tasks' && <TasksTab state={state} api={api} now={now} onDone={onRefresh} />}
        {tab === 'shelf' && <ShelfTab />}
        {tab === 'feed' && <FeedTab state={state} api={api} now={now} paneNames={paneNames} onDone={onRefresh} />}
        {tab === 'setup' && <SetupTab api={api} lendApi={lendClient} displayName={displayName} />}
      </div>
    </div>
  );
}
