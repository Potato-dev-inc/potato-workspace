// The card above a chat when its project used up what it may use today (a limit set in Settings > Agents >
// Limits). New turns in the project wait; a turn that is running finishes. "Raise" gives the limits that ran out more
// room; "Wait until tomorrow" closes the question (the counters start again at midnight by themselves).
// It reads the project's standing when the chat changes (`signal`), not on a timer, and shows nothing without a limit.
import { useEffect, useRef, useState } from 'react';
import { t, useT } from '../../i18n';
import { listen } from '../../lib/events';
import { tauri, type ProjectBudgetStatus } from '../../lib/tauri';
import '../../styles/cockpit-project-budget.css';

function sentence(status: ProjectBudgetStatus): string {
  switch (status.reached) {
    case 'minutes':
      return t('projectBudget.minutes', { n: status.limits.minutesPerDay ?? 0 });
    case 'plan':
      return t('projectBudget.plan', { n: status.limits.planPercent ?? 0 });
    default:
      return t('projectBudget.turns', { n: status.limits.turnsPerDay ?? 0 });
  }
}

export function ProjectBudgetBanner({ paneId, signal }: { paneId: string; signal?: string | number }) {
  const tr = useT();
  const [status, setStatus] = useState<ProjectBudgetStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  // The limit was changed (set to No limit, or raised above what was used): read the standing again, so the card goes.
  const [limitsChanged, setLimitsChanged] = useState(0);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    listen('project-budget://changed', () => setLimitsChanged((n) => n + 1))
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    tauri.projectBudgetStatus(paneId).then(
      (next) => {
        if (!alive.current) return;
        setStatus(next);
        if (!next?.reached) setWaiting(false);
      },
      () => alive.current && setStatus(null),
    );
    return () => {
      alive.current = false;
    };
  }, [paneId, signal, limitsChanged]);

  if (!status?.reached) return null;

  const raise = () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    tauri
      .projectBudgetRaise(paneId)
      .then((next) => {
        if (!alive.current) return;
        setStatus(next);
        setWaiting(false);
      })
      .catch(() => alive.current && setError(true))
      .finally(() => alive.current && setBusy(false));
  };

  return (
    <div className="ck-project-budget" role="status" data-testid="project-budget-card" data-reached={status.reached}>
      <div className="ck-project-budget-text">
        <strong>{tr('projectBudget.title')}</strong>
        <span>{waiting ? tr('projectBudget.waiting') : `${sentence(status)} ${tr('projectBudget.running')}`}</span>
      </div>
      {!waiting && (
        <div className="ck-project-budget-actions">
          <button type="button" className="ck-chat-link" data-budget-action="raise" disabled={busy} onClick={raise}>
            {busy ? tr('projectBudget.raising') : tr('projectBudget.raise')}
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="ck-chat-link" data-budget-action="wait" onClick={() => setWaiting(true)}>
            {tr('projectBudget.wait')}
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="ck-project-budget-error">
          {tr('projectBudget.raiseFailed')}
        </div>
      )}
    </div>
  );
}
