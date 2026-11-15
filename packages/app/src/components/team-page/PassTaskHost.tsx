// "Pass to a teammate…" from a chat's menu: the cockpit asks, this opens the Pass a task sheet over whatever is on screen,
// with the chat's project folder and short summary filled in. Draws nothing until asked.
import { useEffect, useState } from 'react';
import type { LendHandle } from '../lend/useLend';
import { onPassTaskRequest, type PassRequest } from '../../lib/team-pass-bridge';
import { teamApi, type TeamApi, type TeamState } from '../../lib/team';
import { EMPTY_TASKS, teamTasksApi, type TasksView, type TeamTasksApi } from '../../lib/team-tasks';
import { PassTaskSheet } from './PassTaskSheet';
import type { FolderPicker } from './pickFolder';
import { sortPeople, type Person } from './team-page-model';

export function PassTaskHost({
  api = teamApi,
  tasksApi = teamTasksApi,
  teamState,
  lend,
  pick,
}: {
  api?: TeamApi;
  tasksApi?: TeamTasksApi;
  teamState: TeamState | null;
  lend: LendHandle;
  pick?: FolderPicker;
}) {
  const [open, setOpen] = useState<{ req: PassRequest; people: Person[]; tasks: TasksView } | null>(null);
  useEffect(
    () =>
      onPassTaskRequest((req) => {
        void (async () => {
          try {
            const [config, tasks] = await Promise.all([api.configGet(), tasksApi.state().catch(() => EMPTY_TASKS)]);
            setOpen({ req, people: sortPeople(config.members, teamState?.presence ?? [], Date.now()), tasks });
          } catch {
            setOpen(null);
          }
        })();
      }),
    [api, tasksApi, teamState],
  );
  if (!open) return null;
  return (
    <PassTaskSheet
      people={open.people}
      repoPath={open.req.repoPath}
      summary={open.req.summary}
      tasks={open.tasks}
      lend={lend.state}
      api={tasksApi}
      pick={pick}
      onClose={() => setOpen(null)}
      onSent={() => {}}
    />
  );
}
