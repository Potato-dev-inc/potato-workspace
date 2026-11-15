// Plan: only when the agent has one. One row ("3 of 5 done"); a click opens the steps with a check or an empty ring.
import { useState } from 'react';
import { useT } from '../../../i18n';
import type { PlanItem } from '../../../lib/sessionChatModel';
import { RailSection } from './RailSection';

export function PlanSection({ plan }: { plan: readonly PlanItem[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (plan.length === 0) return null;
  const done = plan.filter((p) => p.status === 'completed').length;
  const text = t('rail.plan.done', { done, total: plan.length });
  return (
    <RailSection id="plan" title={t('rail.plan.title')} summary={text}>
      <button type="button" className="rp-row rp-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rp-k">{t('rail.plan.title')}</span>
        <span className="rp-v is-dim">{text}</span>
      </button>
      {open && (
        <ul className="rp-list">
          {plan.map((task, i) => (
            <li key={task.taskId ?? i} className={`rp-row rp-sub is-${task.status}`}>
              <span className={`rp-ring${task.status === 'completed' ? ' is-done' : ''}${task.status === 'in_progress' ? ' is-now' : ''}`} aria-hidden="true" />
              <span className="rp-name" title={task.text}>
                {task.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}
