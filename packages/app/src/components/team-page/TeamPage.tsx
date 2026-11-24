import { useEffect, useState } from 'react';
import '../../styles/connect-tabs.css';
import { StatusIcon } from '../connect/ThisPc';
import { TeamLinkFix } from './TeamLinkFix';
import { InviteSheet } from './InviteSheet';
import { useT } from '../../i18n';
import type { LendApi } from '../../lib/lend';
import { teamTasksApi, type TeamTasksApi } from '../../lib/team-tasks';
import { shelfApi, type ShelfApi } from '../../lib/shelf';
import { teamApi, type InviteView, type TeamApi, type TeamConfigView, type TeamState } from '../../lib/team';
import type { LendHandle } from '../lend/useLend';
import { FeedTab } from './FeedTab';
import { inviteSlot } from './invite-slot';
import { PeopleTab } from './PeopleTab';
import { SetupTab } from './SetupTab';
import { ShelfTab } from './ShelfTab';
import { PassTaskSheet } from './PassTaskSheet';
import type { FolderPicker } from './pickFolder';
import { TasksTab } from './TasksTab';
import { waitingCount } from './tasks-model';
import { useTeamTasks } from './useTeamTasks';
import { hereCount, linkStatus, shareOf, sortPeople, tabCounts, TABS, type TeamTab } from './team-page-model';
import { UsageTab } from './UsageTab';
import { useShelf } from './useShelf';

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
  tasksApi = teamTasksApi,
  pick,
  shelfClient = shelfApi,
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
  tasksApi?: TeamTasksApi;
  pick?: FolderPicker;
  shelfClient?: ShelfApi;
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
  // Only a team whose relay is gone needs to know which relay still works (the one Connect > Devices uses).
  const gone = state.linkDetail?.problem === 'relay_gone';
  const goneHost = state.linkDetail?.host ?? null;
  const [working, setWorking] = useState<{ address: string; host: string } | null>(null);
  useEffect(() => {
    if (!gone || !config.admin || !api.workingRelay) return;
    let live = true;
    void api.workingRelay().then((r) => live && setWorking(r && r.host !== goneHost ? r : null)).catch(() => live && setWorking(null));
    return () => {
      live = false;
    };
  }, [gone, goneHost, config.admin, api]);
  const link = linkStatus(state, { admin: config.admin, workingRelay: working });
  const people = sortPeople(config.members, state.presence ?? [], now);
  const tasks = useTeamTasks(tasksApi);
  const [passFor, setPassFor] = useState<string | null | undefined>(undefined);
  const shelf = useShelf(shelfClient, api);
  const counts = tabCounts(state, config, lend.state, waitingCount(tasks.view), shelf.state?.waiting ?? 0);
  // The header's Invite, and the "Invite a teammate" button in the People and Shelf empty blocks: one action.
  const openInvite = () => void inviteSlot({ api, show: setInvite, openSetup: () => setTab('setup') });
  // This PC was taken off the team: no member list or invite to act on; one line says so, with Leave (clears the team here) and the facts behind it.
  const removed = state.removed === true || config.why?.removed === true;
  if (removed) {
    const why = config.why;
    return (
      <div className="tpg" data-testid="team-page" data-removed="true">
        <header className="tpg-head">
          <div className="tpg-head-main">
            <h1 className="tpg-title">{config.teamName || t('teamHub.title.fallback')}</h1>
          </div>
        </header>
        <div className="tpg-removed" role="alert" data-testid="team-removed">
          <p>{t('teamPage.removed')}</p>
          <button type="button" className="ck-btn ck-btn--secondary" data-testid="team-removed-leave" onClick={() => void api.leave().catch(() => undefined).finally(onRefresh)}>
            {t('teamPage.leave')}
          </button>
        </div>
        <details className="tpg-why" data-testid="team-why">
          <summary>{t('teamPage.whyTitle')}</summary>
          <p className="tpg-sub">
            {t('teamPage.whyRemoved')}{' '}
            {why && t('teamPage.why', { saved: t(why.teamSaved ? 'teamPage.why.yes' : 'teamPage.why.no'), roster: t(why.onRoster ? 'teamPage.why.yes' : 'teamPage.why.no'), check: t(why.lastCheck === null ? 'teamPage.why.ok' : why.lastCheck === 'refused_by_relay' ? 'teamPage.why.refused' : 'teamPage.why.failed') })}
          </p>
        </details>
      </div>
    );
  }

  return (
    <div className="tpg" data-testid="team-page">
      <header className="tpg-head">
        <div className="tpg-head-main">
          <h1 className="tpg-title">{config.teamName || t('teamHub.title.fallback')}</h1>
          <div className="tpg-link" data-testid="team-link" data-link={state.link ?? 'none'} role="status">
            <StatusIcon kind={link.icon} testid="team-link-icon" />
            <div className="tpg-link-text">
              <span className="tpg-link-title">{link.title}</span>
              {link.reason && (
                <span className="tpg-link-why" data-testid="team-link-why">
                  {link.reason}
                </span>
              )}
              <TeamLinkFix api={api} status={link} admin={config.admin} onRefresh={onRefresh} />
            </div>
          </div>
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
          <button type="button" className="ck-btn ck-btn--secondary" data-testid="team-invite" onClick={openInvite}>
            {t('teamHub.invite')}
          </button>
        )}
      </header>
      {passFor !== undefined && <PassTaskSheet people={people} initialMember={passFor} tasks={tasks.view} lend={lend.state} api={tasksApi} pick={pick} onClose={() => setPassFor(undefined)} onSent={tasks.refresh} />}
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
        {tab === 'people' && <PeopleTab people={people} config={config} share={shareOf(state)} api={api} now={now} lendOn={lend.enabled} onAskUsage={() => setTab('usage')} onPassTask={(id) => setPassFor(id)} onChanged={onRefresh} onInvite={config.admin ? openInvite : undefined} />}
        {tab === 'usage' && <UsageTab lend={lend} api={lendClient} team={api} />}
        {tab === 'tasks' && <TasksTab state={state} api={api} tasksApi={tasksApi} tasks={tasks.view} now={now} onDone={onRefresh} onTasksChanged={tasks.refresh} pick={pick} />}
        {tab === 'shelf' && <ShelfTab shelf={shelf} api={shelfClient} onInvite={config.admin ? openInvite : undefined} />}
        {tab === 'feed' && <FeedTab state={state} api={api} now={now} paneNames={paneNames} onDone={onRefresh} />}
        {tab === 'setup' && <SetupTab api={api} lendApi={lendClient} displayName={displayName} />}
      </div>
    </div>
  );
}
