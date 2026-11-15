// Inbox > Team: tasks a teammate passed to me that wait for my answer. The same card as the Tasks tab (Accept…, Decline, ...).
import { useT } from '../../i18n';
import { teamTasksApi, type TeamTasksApi } from '../../lib/team-tasks';
import '../../styles/cockpit-team-page.css';
import { RecvCard } from './TaskCards';
import { recvWaiting } from './tasks-model';
import { useTeamTasks } from './useTeamTasks';

export function InboxTasks({ api = teamTasksApi, now }: { api?: TeamTasksApi; now: number }) {
  const t = useT();
  const { view, refresh } = useTeamTasks(api);
  const waiting = view.received.filter(recvWaiting);
  if (waiting.length === 0) return null;
  return (
    <div className="tpg" data-testid="inbox-tasks">
      <h3 className="tpg-h">{t('teamHub.tasks.inboxHead')}</h3>
      <ul className="tpg-task-list">
        {waiting.map((task) => (
          <li key={task.id}>
            <RecvCard task={task} api={api} now={now} handoverOn={view.handoverOn} lendOn={view.lendOn} onChanged={refresh} />
          </li>
        ))}
      </ul>
    </div>
  );
}
