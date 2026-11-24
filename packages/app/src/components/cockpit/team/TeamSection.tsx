import { useEffect, useState } from 'react';
import { teamApi, type TeamApi } from '../../../lib/team';
import { lendApi, type LendApi } from '../../../lib/lend';
import type { TeamTasksApi } from '../../../lib/team-tasks';
import { InboxTasks } from '../../team-page/InboxTasks';
import { TeamActivity } from '../inbox/TeamActivity';
import { useLend } from '../../lend/useLend';
import { LendEndedRows } from '../../lend/LendEndedRows';
import { TellTeamPrompt } from './TellTeam';
import { TeamJobCard } from './TeamJobCard';
import { useTeam, type TeamHandle } from './useTeam';
import '../../../styles/cockpit-team.css';
import { t, useT } from '../../../i18n';

const DISMISSED_KEY = 'pm.team.removedDismissed.v1';
const dismissedBefore = (): boolean => {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Inbox › Team: below "Done today". My unsent "Tell the team?" drafts and my queued updates and their results,
 * then "Team activity": the team's events as short rows (a row opens its full card in place). While Team is off
 * there is one line with "Set up a team". Request usage lives on the Team page (Settings › Team), not here.
 * Team events do not add to the Needs-you count: they wait for me but block no agent.
 */
export function TeamSection({ api = teamApi, now, paneNames, team, lend: lendClient = lendApi, tasksApi, hideAsked }: { hideAsked?: boolean; api?: TeamApi; now: number; paneNames?: Map<string, string>; team?: TeamHandle; lend?: LendApi; tasksApi?: TeamTasksApi }) {
  useT();
  const own = useTeam(api, !team);
  const { state, refresh } = team ?? own;
  // "Dismiss" on the removed line is kept on this computer: Leave can fail (a computer with no team any more), and the same line came back at every start.
  // It is forgotten once a look shows this computer is no longer "removed" (a rejoin), so a later removal shows again.
  const [dismissed, setDismissed] = useState(dismissedBefore);
  useEffect(() => {
    if (!state || state.removed) return;
    setDismissed(false);
    try {
      window.localStorage.removeItem(DISMISSED_KEY);
    } catch {
      /* ignore */
    }
  }, [state]);
  const dismissRemoved = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    void api.leave().catch(() => {}).finally(refresh);
  };
  const removedShown = state?.removed === true && !dismissed;
  // Share an agent (Labs): the requests to borrow from me show as Team activity rows.
  const lend = useLend(lendClient);
  const asked = hideAsked ? [] : (lend.state?.requests_in.filter((r) => r.state === 'open') ?? []);
  const activity = (
    <>
      <LendEndedRows state={lend.any ?? lend.state} now={now} />
      <TeamActivity state={state} lendState={lend.state} asked={asked} api={api} lendApi={lendClient} now={now} onDone={refresh} onLendDone={lend.refresh} />
    </>
  );
  if (!state?.enabled) return activity;
  const jobs = state.jobs.filter((j) => j.state !== 'discarded');

  return (
    <>
    <section className="ck-team" aria-label={t('r11.t.team')}>
      {state.error && !(state.removed && dismissed) && (
        <p className="ck-team-error" role="alert">
          {state.error}
          {state.removed && (
            <button type="button" className="ck-btn ck-btn--plain" onClick={dismissRemoved}>
              {t('team.removed.dismiss')}
            </button>
          )}
        </p>
      )}
      {state.error && removedShown && (
        <details className="tp-why" data-testid="team-why">
          <summary>{t('teamPage.whyTitle')}</summary>
          <p className="ck-sub">{t('teamPage.whyRemoved')}</p>
        </details>
      )}
      {state.transport === 'relay' && state.link === 'offline' && (
        <p className="ck-sub ck-team-empty">{t('r11.t.offline')}</p>
      )}
      {state.transport === 'relay' && state.link === 'denied' && (
        <p className="ck-sub ck-team-empty">{t('r11.t.denied')}</p>
      )}
      {state.missing > 0 && (
        <div className="ck-team-gap">
          <span className="ck-sub">{t('r11.t.missing')}</span>
          <button
            type="button"
            className="ck-btn ck-btn--plain"
            onClick={() => {
              api
                .clearGaps()
                .catch(() => {})
                .finally(refresh);
            }}
          >
            {t('r11.t.ok')}
          </button>
        </div>
      )}
      {state.drafts.length > 0 && (
        <ul className="ib-list" aria-label={t('r11.t.unsent')}>
          {state.drafts.map((d) => (
            <li key={d.id} className="ib-surface">
              <TellTeamPrompt draft={d} members={state.members} api={api} variant="row" onDone={refresh} />
            </li>
          ))}
        </ul>
      )}

      {jobs.length > 0 && (
        <ul className="ib-list" aria-label={t('r11.t.jobs')}>
          {jobs.map((j) => (
            <li key={j.id}>
              <TeamJobCard job={j} api={api} paneName={j.paneId ? paneNames?.get(j.paneId) : undefined} onDone={refresh} />
            </li>
          ))}
        </ul>
      )}

      <InboxTasks now={now} api={tasksApi} />
    </section>
    {activity}
    </>
  );
}
