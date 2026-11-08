// The agent's task list, pinned at the top of the chat: a collapsible "Plan · 4 steps" with "2 of 4" beside it, then each
// step with a mark (empty ring: to do, turning ring: in progress, tick: done). Shows only; the head folds the list.
import { useState } from 'react';
import type { ChatTurn, PlanItem, PlanStatus } from '../../lib/sessionChatModel';
import '../../styles/chat-agent-cards.css';
import { CheckIcon, Chevron, ListIcon, SpinMark } from './chatCardIcons';
import { plural } from './chatFormat';

/** The task list as it stands now: the list after the newest turn that updated it. Empty when there is none. */
export function currentPlan(turns: readonly ChatTurn[]): PlanItem[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const plan = turns[i]!.plan;
    if (plan) return plan;
  }
  return [];
}

const GLYPH_LABEL: Record<PlanStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
};

function Mark({ status }: { status: PlanStatus }) {
  return (
    <span role="img" aria-label={GLYPH_LABEL[status]} className={`ck-agc-plan-mark ck-chat-plan-glyph--${status}`}>
      {status === 'completed' ? <CheckIcon /> : status === 'in_progress' ? <SpinMark /> : <span className="ck-agc-dot" aria-hidden="true" />}
    </span>
  );
}

export function PlanCard({ items }: { items: readonly PlanItem[] }) {
  const [open, setOpen] = useState(true);
  if (items.length === 0) return null;
  const done = items.filter((item) => item.status === 'completed').length;
  return (
    <section aria-label="Tasks" className="shrink-0 ck-chat-plan ck-agc-plan" data-testid="chat-plan">
      <div className="ck-agc-card ck-agc-card--plan">
        <h3 className="ck-chat-plan-head ck-agc-plan-h">
          <button type="button" aria-expanded={open} className="ck-agc-head" onClick={() => setOpen(!open)}>
            <span className="ck-agc-ico">
              <ListIcon />
            </span>
            <span className="ck-agc-title">
              <b className="ck-agc-name">Plan · {plural(items.length, 'step')}</b>
            </span>
            <span className="ck-agc-badge ck-agc-badge--count" data-testid="plan-progress">
              {done} of {items.length}
            </span>
            <Chevron />
          </button>
        </h3>
        {open && (
          <ol className="ck-agc-tasks ck-chat-plan-list">
            {items.map((item, index) => (
              <li
                key={item.taskId ?? `${index}`}
                data-status={item.status}
                className={`ck-agc-task ck-chat-plan-item ck-chat-plan-item--${item.status}`}
              >
                <Mark status={item.status} />
                <span className="ck-agc-task-text">{item.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
