import { teamApi, type TeamApi } from '../../../lib/team';
import { lendApi, type LendApi } from '../../../lib/lend';
import { TeamActivity } from '../inbox/TeamActivity';
import { useLend } from '../../lend/useLend';
import { TellTeamPrompt } from './TellTeam';
import { TeamJobCard } from './TeamJobCard';
import { useTeam, type TeamHandle } from './useTeam';
import '../../../styles/cockpit-team.css';

/**
 * Inbox › Team: below "Done today". My unsent "Tell the team?" drafts and my queued updates and their results,
 * then "Team activity": the team's events as short rows (a row opens its full card in place). While Team is off
 * there is one line with "Set up a team". Request usage lives on the Team page (Settings › Team), not here.
 * Team events do not add to the Needs-you count: they wait for me but block no agent.
 */
export function TeamSection({ api = teamApi, now, paneNames, team, lend: lendClient = lendApi }: { api?: TeamApi; now: number; paneNames?: Map<string, string>; team?: TeamHandle; lend?: LendApi }) {
  const own = useTeam(api, !team);
  const { state, refresh } = team ?? own;
  // Share an agent (Labs): the requests to borrow from me show as Team activity rows.
  const lend = useLend(lendClient);
  const asked = lend.state?.requests_in.filter((r) => r.state === 'open') ?? [];
  const activity = (
    <TeamActivity state={state} lendState={lend.state} asked={asked} api={api} lendApi={lendClient} now={now} onDone={refresh} onLendDone={lend.refresh} />
  );
  if (!state?.enabled) return activity;
  const jobs = state.jobs.filter((j) => j.state !== 'discarded');

  return (
    <>
    <section className="ck-team" aria-label="Team">
      {state.error && (
        <p className="ck-team-error" role="alert">
          {state.error}
        </p>
      )}
      {state.transport === 'relay' && state.link === 'offline' && (
        <p className="ck-sub ck-team-empty">Can't reach the team's relay. Updates will arrive when it's back.</p>
      )}
      {state.transport === 'relay' && state.link === 'denied' && (
        <p className="ck-sub ck-team-empty">The relay turned this computer away. Ask the owner to let you in again.</p>
      )}
      {state.missing > 0 && (
        <div className="ck-team-gap">
          <span className="ck-sub">Some team updates may be missing.</span>
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
            OK
          </button>
        </div>
      )}
      {state.drafts.length > 0 && (
        <ul className="ib-list" aria-label="Unsent">
          {state.drafts.map((d) => (
            <li key={d.id} className="ib-surface">
              <TellTeamPrompt draft={d} members={state.members} api={api} variant="row" onDone={refresh} />
            </li>
          ))}
        </ul>
      )}

      {jobs.length > 0 && (
        <ul className="ib-list" aria-label="Updates for your branches">
          {jobs.map((j) => (
            <li key={j.id}>
              <TeamJobCard job={j} api={api} paneName={j.paneId ? paneNames?.get(j.paneId) : undefined} onDone={refresh} />
            </li>
          ))}
        </ul>
      )}

    </section>
    {activity}
    </>
  );
}
