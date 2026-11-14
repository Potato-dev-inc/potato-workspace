// The plan line under the phone header (while the agent has a task list that is not finished): "Step 3 of 6 · the step it
// is on" over a thin orange bar. A tap opens the whole list (done ticked, the current step bright). When every step is
// done the line goes away at once: the result card says the rest. Shows only; reads the same list as the desktop's bar.
import { useState } from 'react';
import { useT } from '../../i18n';
import { planProgress } from '../../lib/planProgress';
import type { PlanItem } from '../../lib/sessionChatModel';
import { Chevron } from '../chat/chatCardIcons';
import { PlanMark } from '../chat/PlanCard';
import '../../styles/phone-chat.css';

export function PhonePlanLine({ items }: { items: readonly PlanItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const progress = planProgress(items);
  if (!progress || progress.allDone) return null;
  const step = Math.min(progress.total, progress.done + 1);
  const label = t('phone.plan.step', { n: step, total: progress.total });
  return (
    <section className="ph-plan" aria-label={t('phone.plan.label')} data-testid="plan-bar">
      <button type="button" className="ph-plan-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <b className="ph-plan-n" data-testid="plan-bar-count">
          {label}
        </b>
        {progress.current && (
          <span className="ph-plan-t" data-testid="plan-bar-current">
            · {progress.current}
          </span>
        )}
        <Chevron />
      </button>
      <div className="ph-plan-bar" role="progressbar" aria-label={t('phone.plan.label')} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
      </div>
      {open && (
        <ol className="ph-plan-list" data-testid="plan-bar-list">
          {items.map((item, index) => (
            <li key={item.taskId ?? `${index}`} data-status={item.status} className="ph-plan-item">
              <PlanMark status={item.status} />
              <span className="ph-plan-text">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
