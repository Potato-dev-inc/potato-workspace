import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { TeamApi, TeamState } from '../../lib/team';
import type { TasksView, TeamTasksApi } from '../../lib/team-tasks';
import { TeamCard } from '../cockpit/team/TeamCard';
import type { FolderPicker } from './pickFolder';
import { RecvCard, SentCard } from './TaskCards';
import { recvWaiting } from './tasks-model';
import { tasksForMe } from './team-page-model';

/**
 * Tasks. "For you": tasks a teammate passed to me, and the review requests and notes (their heads-up cards). "You passed":
 * what I passed on and how far it got. A teammate's text is untrusted: the cards show it as plain, quoted text and run nothing.
 * The foot holds the one switch for sending and getting repos.
 */
export function TasksTab({
  state,
  api,
  tasksApi,
  tasks,
  now,
  onDone,
  onTasksChanged,
  pick,
}: {
  state: TeamState;
  api: TeamApi;
  tasksApi: TeamTasksApi;
  tasks: TasksView;
  now: number;
  onDone: () => void;
  onTasksChanged: () => void;
  pick?: FolderPicker;
}) {
  const t = useT();
  const reviews = tasksForMe(state.cards);
  // Waiting ones first, then the rest by time (newest first).
  const received = [...tasks.received].sort((a, b) => Number(recvWaiting(b)) - Number(recvWaiting(a)) || b.updatedMs - a.updatedMs);
  const sent = [...tasks.sent].sort((a, b) => b.updatedMs - a.updatedMs);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setHandover = async (on: boolean) => {
    setError(null);
    try {
      await tasksApi.handoverSet(on);
      setAsking(false);
      onTasksChanged();
    } catch (e) {
      setError(errorSentence(e));
    }
  };

  const none = reviews.length === 0 && received.length === 0 && sent.length === 0;
  return (
    <div className="tpg-tasks">
      {none && (
        <p className="tpg-sub tpg-empty" data-testid="tasks-empty">
          {t('teamHub.tasks.empty')}
        </p>
      )}
      {!none && (
        <>
          <section aria-label={t('teamHub.tasks.forYou')}>
            <h3 className="tpg-h">{t('teamHub.tasks.forYou')}</h3>
            {reviews.length === 0 && received.length === 0 && <p className="tpg-sub">{t('teamHub.tasks.noneForYou')}</p>}
            <ul className="tpg-task-list" data-testid="tasks-for-you">
              {received.map((task) => (
                <li key={task.id}>
                  <RecvCard task={task} api={tasksApi} now={now} handoverOn={tasks.handoverOn} lendOn={tasks.lendOn} onChanged={onTasksChanged} pick={pick} />
                </li>
              ))}
            </ul>
            {reviews.length > 0 && (
              <ul className="ib-list">
                {reviews.map((card) => (
                  <li key={card.id}>
                    <TeamCard card={card} api={api} now={now} onDone={onDone} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label={t('teamHub.tasks.passed')}>
            <h3 className="tpg-h">{t('teamHub.tasks.passed')}</h3>
            {sent.length === 0 && <p className="tpg-sub">{t('teamHub.tasks.nonePassed')}</p>}
            <ul className="tpg-task-list" data-testid="tasks-passed">
              {sent.map((task) => (
                <li key={task.id}>
                  <SentCard task={task} api={tasksApi} now={now} onChanged={onTasksChanged} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <footer className="tpg-tasks-foot" data-testid="handover-switch">
        <label className="tpg-tick">
          <input
            type="checkbox"
            role="switch"
            checked={tasks.handoverOn}
            onChange={(e) => (e.target.checked ? setAsking(true) : void setHandover(false))}
            data-testid="handover-toggle"
          />
          <span>{t('teamHub.tasks.handover')}</span>
        </label>
        <small className="tpg-sub">{t('teamHub.tasks.handover.note')}</small>
        {asking && (
          <div className="tpg-risk" role="group" data-testid="handover-confirm">
            <strong>{t('teamHub.tasks.handover.ask')}</strong>
            <p>{t('teamHub.tasks.handover.risk')}</p>
            <div className="tpg-actions">
              <button type="button" className="ck-btn ck-btn--primary" data-testid="handover-yes" onClick={() => void setHandover(true)}>
                {t('teamHub.tasks.handover.on')}
              </button>
              <button type="button" className="ck-btn ck-btn--plain" onClick={() => setAsking(false)}>
                {t('teamHub.tasks.cancel')}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="tpg-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </div>
  );
}
