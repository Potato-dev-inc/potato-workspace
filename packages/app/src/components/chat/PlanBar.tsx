// The agent's plan as one slim bar at the top of the chat: "3 of 7 · the step it is on" over a thin progress line.
// A click opens the whole checklist (done ticked, the current step bright, the rest dim). When every step is done it
// reads "Done · 7 of 7" for a moment and then folds away. Shows only; it reads the same list the plan card does.
import { useEffect, useState } from 'react';
import { planProgress } from '../../lib/planProgress';
import type { PlanItem } from '../../lib/sessionChatModel';
import '../../styles/plan-bar.css';
import { Chevron } from './chatCardIcons';
import { PlanMark } from './PlanCard';

/** How long "Done" stays before the bar folds. */
export const PLAN_DONE_MS = 4000;

export function PlanBar({ items }: { items: readonly PlanItem[] }) {
  const progress = planProgress(items);
  const allDone = progress?.allDone ?? false;
  const [open, setOpen] = useState(false);
  // A list that was already finished when the chat opened does not show again.
  const [folded, setFolded] = useState(allDone);
  useEffect(() => {
    if (!allDone) {
      setFolded(false);
      return;
    }
    const timer = setTimeout(() => setFolded(true), PLAN_DONE_MS);
    return () => clearTimeout(timer);
  }, [allDone]);
  if (!progress || folded) return null;
  const label = allDone ? `Done · ${progress.done} of ${progress.total}` : `${progress.done} of ${progress.total}`;
  return (
    <section aria-label="Plan progress" className="shrink-0 ck-planbar" data-testid="plan-bar" data-done={allDone ? 'true' : 'false'}>
      <button type="button" className="ck-planbar-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b className="ck-planbar-count" data-testid="plan-bar-count">
          {label}
        </b>
        {progress.current && !allDone && (
          <span className="ck-planbar-current" data-testid="plan-bar-current">
            · {progress.current}
          </span>
        )}
        <Chevron />
      </button>
      <div
        className="ck-planbar-line"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
      >
        <span className="ck-planbar-fill" style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
      </div>
      {open && (
        <ol className="ck-planbar-list" data-testid="plan-bar-list">
          {items.map((item, index) => (
            <li key={item.taskId ?? `${index}`} data-status={item.status} className={`ck-planbar-item ck-planbar-item--${item.status}`}>
              <PlanMark status={item.status} />
              <span className="ck-planbar-text">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
