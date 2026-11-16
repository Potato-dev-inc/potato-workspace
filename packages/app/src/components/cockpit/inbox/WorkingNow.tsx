// Inbox > Working now: one quiet row per chat that is working, under the cards. Click the row (or "Open chat") to
// go to it; Stop interrupts it. Five rows, then "Show all". Never part of "Needs you": no number, no sound.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { AgentLogo } from '../../common/AgentLogo';
import { WORKING_SHOWN, type WorkingRow } from '../../../lib/working-now';
import { formatElapsed } from '../model';
import { rowOpenProps } from './row-open';

export function WorkingNow({
  rows,
  names,
  now,
  onOpen,
  onStop,
  onShowInCrew,
}: {
  rows: ReadonlyArray<WorkingRow>;
  names: ReadonlyMap<string, string>;
  now: number;
  onOpen: (paneId: string) => void;
  onStop: (paneId: string) => void;
  /** Gives the row a "Show in crew" button when this returns a function (the chat is a crew box). */
  onShowInCrew?: (paneId: string) => (() => void) | undefined;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, WORKING_SHOWN);
  return (
    <section className="ib-sec" aria-label={t('inbox.workingNow')} data-testid="working-now">
      <h2 className="ib-lab">
        <span>{t('inbox.workingNow')}</span>
        <span className="ib-lab-n">· {rows.length}</span>
      </h2>
      <ul className="ib-rows">
        {shown.map((r) => {
          const title = names.get(r.paneId) ?? r.agent;
          const show = onShowInCrew?.(r.paneId);
          return (
            <li key={r.paneId} className="ib-row" data-working-row={r.paneId} tabIndex={0} {...rowOpenProps(() => onOpen(r.paneId))}>
              <AgentLogo id={r.agent} size={16} decorative />
              <div className="ib-row-tx">
                <span className="ib-row-tt">{title}</span>
                <span className="ib-row-sb">{r.step ?? t('inbox.workingNoStep')}</span>
              </div>
              <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--secondary" aria-label={t('inbox.workingOpenNamed', { name: title })} onClick={() => onOpen(r.paneId)}>
                {t('inbox.workingOpen')}
              </button>
              <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--plain" aria-label={t('inbox.workingStopNamed', { name: title })} onClick={() => onStop(r.paneId)}>
                {t('inbox.workingStop')}
              </button>
              {show && (
                <button type="button" className="ib-row-go ck-btn ck-btn--sm ck-btn--plain" aria-label={t('inbox.showInCrewNamed', { name: title })} onClick={show}>
                  {t('inbox.showInCrew')}
                </button>
              )}
              <time className="ib-when">{r.since === null ? '' : formatElapsed(now - r.since)}</time>
            </li>
          );
        })}
      </ul>
      {rows.length > WORKING_SHOWN && (
        <button type="button" className="ib-more" onClick={() => setAll((v) => !v)}>
          {all ? t('inbox.workingShowFewer') : t('inbox.workingShowAll', { n: rows.length })}
        </button>
      )}
    </section>
  );
}
