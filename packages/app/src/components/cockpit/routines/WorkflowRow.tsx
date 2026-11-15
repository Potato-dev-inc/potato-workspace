import { useState } from 'react';
import { type MessageKey, useLanguage, useT } from '../../../i18n';
import type { WorkflowView } from '../../../lib/routines';
import { formatWhen, stepText, whenText } from './routines-text';

/** One routine or chain: what starts it, its steps, when it runs next, and its buttons. */
export function WorkflowRow({
  w,
  agentLabel,
  busy,
  onRunNow,
  onToggle,
  onDelete,
}: {
  w: WorkflowView;
  agentLabel: (id: string) => string;
  busy: boolean;
  onRunNow: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const lang = useLanguage();
  const [confirming, setConfirming] = useState(false);
  const status = w.running
    ? t('routines.running')
    : !w.enabled
      ? t('routines.off')
      : w.nextMs
        ? t('routines.next', { when: formatWhen(w.nextMs, lang) })
        : '';
  const last = w.lastRunMs ? t('routines.last', { result: w.lastResult ? t(`routines.state.${w.lastResult}` as MessageKey) : '', when: formatWhen(w.lastRunMs, lang) }) : t('routines.neverRun');
  return (
    <li className={`ck-routines-row${w.enabled ? '' : ' is-off'}`} data-testid={`workflow-${w.id}`}>
      <div className="ck-routines-row-main">
        <div className="ck-routines-row-title">
          <strong>{w.name}</strong>
          {status && <span className="ck-routines-pill">{status}</span>}
        </div>
        <div className="ck-sub">{whenText(w, t)}</div>
        <ol className="ck-routines-steps">
          {w.steps.map((s, i) => (
            <li key={i}>{stepText(s, t, agentLabel)}</li>
          ))}
        </ol>
        <div className="ck-sub">{last}</div>
        {w.pausedNote && !w.enabled && <div className="ck-sub ck-routines-paused">{t(`routines.paused.${w.pausedNote}` as MessageKey)}</div>}
      </div>
      <div className="ck-routines-row-actions">
        <button type="button" className="ck-btn ck-btn--plain" disabled={busy || w.running} onClick={onRunNow}>
          {t('routines.runNow')}
        </button>
        <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={onToggle}>
          {w.enabled ? t('routines.turnOff') : t('routines.turnOn')}
        </button>
        {confirming ? (
          <>
            <span className="ck-sub">{t('routines.confirmDelete', { name: w.name })}</span>
            <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>
              {t('routines.yes')}
            </button>
            <button type="button" className="ck-btn ck-btn--plain" onClick={() => setConfirming(false)}>
              {t('routines.form.cancel')}
            </button>
          </>
        ) : (
          <button type="button" className="ck-btn ck-btn--plain" disabled={busy} onClick={() => setConfirming(true)}>
            {t('routines.delete')}
          </button>
        )}
      </div>
    </li>
  );
}
