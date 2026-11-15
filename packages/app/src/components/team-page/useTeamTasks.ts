import { useCallback, useEffect, useState } from 'react';
import { EMPTY_TASKS, teamTasksApi, type TasksView, type TeamTasksApi } from '../../lib/team-tasks';

const REFRESH_MS = 30_000;

export interface TasksHandle {
  view: TasksView;
  refresh: () => void;
}

/** The tasks, read again when the backend says they changed and now and then. An older backend or no desktop shell: nothing. */
export function useTeamTasks(api: TeamTasksApi = teamTasksApi, enabled = true): TasksHandle {
  const [view, setView] = useState<TasksView>(EMPTY_TASKS);
  const refresh = useCallback(() => {
    api
      .state()
      .then((v) => setView(v && Array.isArray(v.sent) && Array.isArray(v.received) ? v : EMPTY_TASKS))
      .catch(() => setView(EMPTY_TASKS));
  }, [api]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    let off: (() => void) | undefined;
    let disposed = false;
    api
      .onChanged(refresh)
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(timer);
    };
  }, [api, refresh, enabled]);
  return { view, refresh };
}
