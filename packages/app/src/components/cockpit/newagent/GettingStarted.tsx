// "Getting started · 2 of 6" on the New agent page: six real things, each ticks itself when it happens anywhere in the
// app (lib/getting-started.ts). Each open row has one button that takes the person there. Hide removes the card; when
// all six are done the Potato celebrates once and the card never comes back. Every step works with terminals hidden.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { hideGettingStarted, markCelebrated, requestGettingStarted, STEP_IDS, useGettingStarted, type StepId } from '../../../lib/getting-started';
import { openSettingsAt } from '../../../lib/openSettingsAt';
import { PotatoMark } from '../Icons';
import '../../../styles/cockpit-getting-started.css';

/** How long the celebration shows before the card goes for good. */
export const CELEBRATE_MS = 4500;

export function GettingStarted({ onStartAgent, agentCount }: { onStartAgent: () => void; agentCount: number }) {
  const t = useT();
  // One plain line under the list when a button cannot do its thing yet (two side by side needs two agents).
  const [note, setNote] = useState('');
  const gs = useGettingStarted();
  const celebrating = gs.allDone && !gs.celebrated;

  // The celebration shows once, then the card is gone for good.
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(markCelebrated, CELEBRATE_MS);
    return () => window.clearTimeout(timer);
  }, [celebrating]);

  if (gs.hidden || gs.celebrated || !gs.seeded) return null;

  if (celebrating) {
    return (
      <section className="ck-na-gs ck-na-gs--done" aria-label={t('gs.celebrate')} data-testid="getting-started">
        <PotatoMark size={44} state="celebrate" />
        <p role="status">{t('gs.celebrate')}</p>
      </section>
    );
  }

  const go: Record<StepId, () => void> = {
    second: onStartAgent,
    side: () => {
      setNote(agentCount >= 2 ? '' : t('gs.side.needTwo'));
      if (agentCount >= 2) requestGettingStarted('side');
    },
    review: () => requestGettingStarted('review'),
    undo: () => requestGettingStarted('undo'),
    phone: () => openSettingsAt('phone'),
    limit: () => openSettingsAt('general', 'budget-turns'),
  };

  return (
    <section className="ck-na-gs" aria-label={t('gs.title', { done: gs.doneCount, total: gs.total })} data-testid="getting-started">
      <header className="ck-na-gs-head">
        <h2 className="ck-na-hc-title">{t('gs.title', { done: gs.doneCount, total: gs.total })}</h2>
        <button type="button" className="ck-na-gs-hide" aria-label={t('gs.hideLabel')} onClick={hideGettingStarted}>
          {t('gs.hide')}
        </button>
      </header>
      <ul className="ck-na-gs-list">
        {STEP_IDS.map((id) => {
          const done = gs.done.includes(id);
          return (
            <li key={id} className={`ck-na-gs-row${done ? ' is-done' : ''}`} data-step={id} data-done={done ? 'true' : 'false'}>
              <span className="ck-na-gs-tick" role="img" aria-label={done ? t('gs.tickDone') : t('gs.tickTodo')}>
                {done ? '✓' : ''}
              </span>
              <span className="ck-na-gs-text">
                <span className="ck-na-gs-name">{t(`gs.${id}`)}</span>
                {!done && <span className="ck-na-gs-hint">{t(`gs.${id}.hint`)}</span>}
              </span>
              {!done && (
                <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" onClick={go[id]}>
                  {t(`gs.${id}.go`)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {note && (
        <p className="ck-na-gs-note" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
