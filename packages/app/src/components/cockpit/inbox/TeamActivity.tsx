// Inbox › Team activity: the team's recent events, newest first, five at most. "View" shows the full Team card in place
// (Pull now, Queue my agent and the rest stay one click away); a borrow request opens its answer card in place.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { activityRows, ACTIVITY_MAX, whenLabel, type ActivityRow } from '../../../lib/inbox-activity';
import type { TeamApi, TeamState } from '../../../lib/team';
import type { LendApi, LendState } from '../../../lib/lend';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { IncomingRequestCard } from '../../lend/IncomingRequestCard';
import { rowOpenProps } from './row-open';
import { TeamCard } from '../team/TeamCard';
import { IconAlert, IconLend, IconNoteSmall, IconPullRequest, IconPush, IconTick } from './ActivityIcons';

const ICON = { pr: IconPullRequest, push: IconPush, lend: IconLend, ok: IconTick, danger: IconAlert, note: IconNoteSmall } as const;

export function TeamActivity({
  state,
  lendState,
  asked,
  api,
  lendApi,
  now,
  onDone,
  onLendDone,
}: {
  state: TeamState | null;
  lendState: LendState | null;
  asked: LendState['requests_in'];
  api: TeamApi;
  lendApi: LendApi;
  now: number;
  onDone: () => void;
  onLendDone: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const noTeam = !state?.enabled;
  const rows = noTeam ? [] : activityRows(state!.cards, asked, lendState).slice(0, ACTIVITY_MAX);
  const openTeam = () => openSettingsAt('team');

  const body = (r: ActivityRow) =>
    r.card ? (
      <TeamCard card={r.card} api={api} now={now} onDone={onDone} />
    ) : r.request && lendState ? (
      <IncomingRequestCard request={r.request} state={lendState} api={lendApi} now={now} onDone={onLendDone} />
    ) : null;

  return (
    <section className="ib-sec" aria-label={t('inbox.teamActivity')} data-testid="team-activity">
      <h2 className="ib-lab">
        <span>{t('inbox.teamActivity')}</span>
        <span className="ib-sp" />
        {!noTeam && (
          <button type="button" className="ib-lab-btn" onClick={openTeam}>
            {t('inbox.openTeam')}
          </button>
        )}
      </h2>
      {noTeam ? (
        <p className="ib-none">
          {t('inbox.teamNone')}{' '}
          <button type="button" className="ck-btn ck-btn--sm ck-btn--plain" onClick={openTeam}>
            {t('inbox.teamSetUp')}
          </button>
        </p>
      ) : rows.length === 0 ? (
        <p className="ib-none">{state?.active ? t('inbox.teamQuiet') : t('inbox.teamFinishSetup')}</p>
      ) : (
        <ul className="ib-rows">
          {rows.map((r) => {
            const Icon = ICON[r.tone];
            const expanded = open === r.id;
            return (
              <li key={r.id} data-team-activity={r.id}>
                <div className="ib-row" {...rowOpenProps(() => setOpen(expanded ? null : r.id))}>
                  <span className={`ib-tile ib-tile--${r.tone}`} data-tone={r.tone}>
                    <Icon />
                  </span>
                  <div className="ib-row-tx">
                    <span className="ib-row-tt">{r.line}</span>
                    <span className="ib-row-sb">{r.sub}</span>
                  </div>
                  <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--secondary" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)}>
                    {r.request ? t('inbox.teamAnswer') : t('inbox.teamView')}
                  </button>
                  <time className="ib-when">{whenLabel(r.atMs, now)}</time>
                </div>
                {expanded && <div className="ib-row-body">{body(r)}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
