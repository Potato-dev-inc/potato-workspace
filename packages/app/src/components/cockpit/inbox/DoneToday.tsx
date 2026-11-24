// Inbox › Done today: what finished since midnight, one quiet row per chat. Review (there are changes), Open, or
// Morning report (a night shift). Reads the turn summaries the cockpit already holds; "Clear" hides today's rows only.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { AgentLogo } from '../../common/AgentLogo';
import { clearDoneToday, clockTime, DONE_SHOWN, doneClearedToday, doneToday, type DoneRow } from '../../../lib/done-today';
import type { TurnSummary } from '../../../lib/cockpit-api';
import { rowOpenProps } from './row-open';

const num = (n: number) => n.toLocaleString('en-US');

/** The last name each chat had while it was open: a row of a closed chat keeps it instead of falling back to the bare agent name. */
const lastNames = new Map<string, string>();

export function DoneToday({
  summaries,
  names,
  now,
  onOpen,
  onMorning,
  hasPane,
  onClosed,
  onSignIn,
}: {
  summaries: ReadonlyMap<string, TurnSummary>;
  names: ReadonlyMap<string, string>;
  now: number;
  onOpen: (paneId: string) => void;
  /** The Morning report page; absent: a night-shift row opens its chat like any other. */
  onMorning?: () => void;
  /** Is this chat still open? Absent: every row is open. */
  hasPane?: (paneId: string) => boolean;
  /** A row of a closed chat was picked: the page says so in plain words. */
  onClosed?: (paneId: string) => void;
  /** Sign in for a chat that needs setup (absent: Open). */
  onSignIn?: () => void;
}) {
  const t = useT();
  const [cleared, setCleared] = useState(() => doneClearedToday(now));
  const [all, setAll] = useState(false);
  const rows = cleared ? [] : doneToday(summaries.values(), now);
  const shown = all ? rows : rows.slice(0, DONE_SHOWN);

  const go = (r: DoneRow) => () => {
    if (r.kind === 'night' && onMorning) onMorning();
    else if (hasPane && !hasPane(r.paneId)) onClosed?.(r.paneId);
    else onOpen(r.paneId);
  };

  const second = (r: DoneRow) =>
    r.kind === 'setup' ? t('inbox.doneSetup') : r.files > 0 ? (
      <>
        {t('inbox.doneFiles', { count: r.files })} <span className="ib-add">+{num(r.added)}</span> <span className="ib-del">−{num(r.deleted)}</span>
        {r.checks ? ` · ${r.checks}` : ''}
      </>
    ) : (
      t('inbox.doneNoChanges')
    );

  return (
    <section className="ib-sec" aria-label={t('inbox.doneToday')} data-testid="done-today">
      <h2 className="ib-lab">
        <span>{t('inbox.doneToday')}</span>
        {rows.length > 0 && <span className="ib-lab-n">· {rows.length}</span>}
        <span className="ib-sp" />
        {rows.length > 0 && (
          <button
            type="button"
            className="ib-lab-btn"
            onClick={() => {
              clearDoneToday(now);
              setCleared(true);
            }}
          >
            {t('inbox.doneClear')}
          </button>
        )}
      </h2>
      {rows.length === 0 ? (
        <p className="ib-none">{t('inbox.doneNone')}</p>
      ) : (
        <ul className="ib-rows">
          {shown.map((r) => {
            const known = names.get(r.paneId);
            if (known) lastNames.set(r.paneId, known);
            const title = known ?? lastNames.get(r.paneId) ?? r.agent;
            const label = r.kind === 'setup' && onSignIn ? t('inbox.doneSignIn') : r.kind === 'night' ? t('inbox.doneMorning') : r.kind === 'review' ? t('inbox.doneReview') : t('inbox.doneOpen');
            return (
              <li key={r.paneId} className="ib-row" data-done-row={r.paneId} data-kind={r.kind} {...rowOpenProps(go(r))}>
                <AgentLogo id={r.agent} size={16} decorative />
                <div className="ib-row-tx">
                  <span className="ib-row-tt">{title}</span>
                  <span className="ib-row-sb">{second(r)}</span>
                </div>
                <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--secondary" aria-label={`${label}: ${title}`} onClick={r.kind === 'setup' && onSignIn ? onSignIn : go(r)}>
                  {label}
                </button>
                <time className="ib-when" dateTime={new Date(r.endedAtMs).toISOString()}>
                  {clockTime(r.endedAtMs)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > DONE_SHOWN && (
        <button type="button" className="ib-more" onClick={() => setAll((v) => !v)}>
          {all ? t('inbox.doneShowFewer') : t('inbox.doneShowAll', { n: rows.length })}
        </button>
      )}
    </section>
  );
}
