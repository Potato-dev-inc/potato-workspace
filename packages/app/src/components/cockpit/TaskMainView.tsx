// A background task that sits in the sidebar, opened in the main area at full width. A minion shows its read-only view (the work
// it does: no message box, no Allow buttons; its agent runs it, the person reads it and may stop it). A command shows what it is
// running, with Stop. It is the same view the details column shows, in the main area.
import { useEffect } from 'react';
import '../../styles/cockpit-tasks.css';
import { useT } from '../../i18n';
import type { CockpitApi } from '../../hooks/useCockpit';
import { tauriJobsApi, type JobsApi } from '../../lib/pane-jobs';
import { minionPaneOf, useTaskPlacement } from '../../lib/task-sidebar';
import { parseJobTask } from './useSidebarTasks';
import { stopJob } from './rail/jobActions';
import { TaskSideView } from './rail/TaskSideView';
import { TerminalPane } from './rail/TerminalPane';
import type { HelperRow } from './rail/BackgroundSection';

export function TaskMainView({ c, taskId, onGone, jobsApi = tauriJobsApi }: { c: CockpitApi; taskId: string; onGone: () => void; jobsApi?: JobsApi }) {
  const t = useT();
  const place = useTaskPlacement(taskId);
  const paneId = minionPaneOf(taskId);
  const pane = paneId ? c.registry.paneList.find((p) => p.info.id === paneId) : undefined;
  const owner = place ? c.names.get(place.owner) ?? place.owner : '';
  // The row was put back in Background tasks, or its pane closed: there is nothing to show here any more.
  const gone = !place || (paneId !== null && !pane);
  useEffect(() => {
    if (gone) onGone();
  }, [gone, onGone]);
  if (!place) return null;
  if (paneId && pane) {
    const row: HelperRow = {
      id: pane.info.id,
      title: place.name,
      agent: c.names.get(pane.info.id) ?? pane.info.agent_type,
      agentType: pane.info.agent_type,
      status: pane.status,
      kind: 'minion',
      startedAtMs: pane.info.created_at,
    };
    return (
      <section className="tk-main" data-testid="task-main" data-task-id={taskId} aria-label={place.name}>
        <header className="tk-main-head">
          <h2 className="tk-main-title">{place.name}</h2>
          <span className="tk-main-tag">{t('taskdrag.tag.minion')}</span>
        </header>
        <TaskSideView row={row} parentName={owner} onStop={(id) => c.interrupt(id)} />
      </section>
    );
  }
  const job = parseJobTask(taskId);
  if (!job) return null;
  return (
    <section className="tk-main" data-testid="task-main" data-task-id={taskId} aria-label={place.name}>
      <header className="tk-main-head">
        <h2 className="tk-main-title">{place.name}</h2>
        <span className="tk-main-tag">{t('taskdrag.tag.command')}</span>
      </header>
      <TerminalPane
        term={{ owner: job.owner, pid: job.pid, startedAtMs: job.startedAtMs, name: place.name, command: place.command ?? place.name }}
        onStop={(o, pid, started) => stopJob(jobsApi, o, pid, started)}
      />
    </section>
  );
}
