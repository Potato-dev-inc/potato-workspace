// Background tasks as sidebar rows: which ones to draw, where (under their agent, or on their own), what a drop or a menu
// choice does, and the hand-over question when a minion is let go on a different agent. The Sidebar holds the result.
//
// Dropping a Background tasks row:
//   on the agent that owns it (the middle of its row)  nothing: it is already that agent's
//   at the bottom edge of the agent that owns it       it is shown under that agent
//   on a different agent                               "Hand this to Claude 2?" (a minion), or "This belongs to Claude 1" (a command)
//   on empty sidebar space                             it is shown on its own; the owner is unchanged
// The owner never changes by a move in the sidebar: a task still stops with its agent. Only a hand-over changes it.
import { useEffect, type RefObject } from 'react';
import { useT } from '../../i18n';
import { announce } from '../dnd/announce';
import { registerDropZone, type DragPayload } from '../dnd/dragStore';
import { errorSentence } from '../../lib/sayError';
import { runTime, tauriJobsApi, usePaneJobs, type JobsApi, type PaneJob } from '../../lib/pane-jobs';
import { askHandOver } from '../../lib/task-handover';
import { minionPaneOf, ownRows, placeTask, removeTaskFromSidebar, showTaskInSidebar, taskRowsOf, useTaskSidebar, type TaskPlacement } from '../../lib/task-sidebar';
import { stopJob } from './rail/jobActions';
import { SidebarTaskRow, type TaskRowActions, type TaskState } from './SidebarTaskRow';
import { formatElapsed } from './model';
import type { CockpitApi } from '../../hooks/useCockpit';

type Pane = CockpitApi['registry']['paneList'][number];

/** `job:<owner>:<pid>:<started_ms>` -> the process, or null. The owner id may hold colons, so it is read from the end. */
export function parseJobTask(taskId: string): { owner: string; pid: number; startedAtMs: number } | null {
  if (!taskId.startsWith('job:')) return null;
  const rest = taskId.slice(4);
  const last = rest.lastIndexOf(':');
  const mid = last > 0 ? rest.lastIndexOf(':', last - 1) : -1;
  if (mid < 1) return null;
  const pid = Number(rest.slice(mid + 1, last));
  const startedAtMs = Number(rest.slice(last + 1));
  return Number.isFinite(pid) && Number.isFinite(startedAtMs) ? { owner: rest.slice(0, mid), pid, startedAtMs } : null;
}

export interface SidebarTasks {
  /** The rows nested under this agent. */
  rowsFor: (agentId: string) => JSX.Element[];
  /** The tasks shown on their own, as a group (null when there are none). */
  ownGroup: JSX.Element | null;
  /** A Background tasks row was let go on an agent's row (`agent`: middle, `under`: bottom edge). */
  onTaskDrop: (payload: DragPayload, agentId: string, where: 'agent' | 'under') => void;
}

export function useSidebarTasks(args: {
  c: CockpitApi;
  /** The panes drawn as agent rows (a task nests only under one of these). */
  agentIds: ReadonlySet<string>;
  nameOf: (paneId: string) => string;
  sideRef: RefObject<HTMLElement | null>;
  openTaskId: string | null;
  onOpenTask?: (taskId: string | null) => void;
  jobsApi?: JobsApi;
}): SidebarTasks {
  const { c, agentIds, nameOf, sideRef, openTaskId, onOpenTask, jobsApi = tauriJobsApi } = args;
  const t = useT();
  const placements = useTaskSidebar();
  const jobs = usePaneJobs();
  const list = c.registry.paneList;
  const paneOf = (id: string): Pane | undefined => list.find((p) => p.info.id === id);

  /** What a placement is right now, or null when it cannot be drawn (its pane or its agent is gone). */
  const view = (row: TaskPlacement): { state: TaskState; agentType: string | null; time: string; ports: readonly number[] } | null => {
    if (!paneOf(row.owner)) return null;
    if (row.kind === 'minion') {
      const pane = paneOf(minionPaneOf(row.task_id) ?? '');
      if (!pane) return null;
      const state: TaskState = pane.status === 'running' ? 'running' : pane.status === 'waiting_input' ? 'waiting_input' : pane.status === 'error' ? 'failed' : 'done';
      return { state, agentType: pane.info.agent_type, time: formatElapsed(c.now - pane.info.created_at), ports: [] };
    }
    const ref = parseJobTask(row.task_id);
    const job: PaneJob | undefined = ref ? (jobs[ref.owner] ?? []).find((j) => j.pid === ref.pid && j.startedAtMs === ref.startedAtMs) : undefined;
    return { state: job ? 'running' : 'done', agentType: null, time: job ? runTime(job.startedAtMs, c.now) : '', ports: job?.ports ?? [] };
  };

  const drawable = placements.filter((r) => view(r) !== null);
  const nestedUnder = (row: TaskPlacement): string | null => (row.under && agentIds.has(row.under) ? row.under : null);
  const handTargetsOf = (row: TaskPlacement) => [...agentIds].filter((id) => id !== row.owner).map((id) => ({ id, name: nameOf(id) }));

  const shownUnder = (row: TaskPlacement, under: string | null) => {
    const label = row.name;
    return showTaskInSidebar({ ...row, under }).then(() => announce(under ? t('taskdrag.announce.under', { task: label, name: nameOf(under) }) : t('taskdrag.announce.alone', { task: label })));
  };
  const fail = (e: unknown) => c.notify(errorSentence(e));

  const actions: TaskRowActions = {
    open: (row) => onOpenTask?.(row.task_id),
    detach: (row) => void placeTask(row.task_id, null).then(() => announce(t('taskdrag.announce.alone', { task: row.name }))).catch(fail),
    putBack: (row) => void placeTask(row.task_id, row.owner).then(() => announce(t('taskdrag.announce.under', { task: row.name, name: nameOf(row.owner) }))).catch(fail),
    back: (row) => {
      void removeTaskFromSidebar(row.task_id)
        .then(() => announce(t('taskdrag.announce.back', { task: row.name })))
        .catch(fail);
      if (openTaskId === row.task_id) onOpenTask?.(null);
    },
    hand: (row, toId) => {
      const pane = minionPaneOf(row.task_id);
      if (pane) askHandOver({ taskPane: pane, taskName: row.name, fromId: row.owner, fromName: nameOf(row.owner), toId, toName: nameOf(toId) });
    },
    stop: async (row) => {
      const pane = minionPaneOf(row.task_id);
      if (pane) return void (await c.interrupt(pane));
      const ref = parseJobTask(row.task_id);
      if (ref) await stopJob(jobsApi, ref.owner, ref.pid, ref.startedAtMs);
    },
    close: (row) => {
      void removeTaskFromSidebar(row.task_id).catch(fail);
      if (openTaskId === row.task_id) onOpenTask?.(null);
    },
  };

  const rowView = (row: TaskPlacement, nested: boolean): JSX.Element | null => {
    const v = view(row);
    if (!v) return null;
    return (
      <SidebarTaskRow
        key={row.task_id}
        row={row}
        state={v.state}
        agentType={v.agentType}
        ownerName={nameOf(row.owner)}
        nested={nested}
        active={openTaskId === row.task_id}
        time={v.time}
        ports={v.ports}
        handTargets={row.kind === 'minion' ? handTargetsOf(row) : []}
        actions={actions}
      />
    );
  };

  const onTaskDrop: SidebarTasks['onTaskDrop'] = (payload, agentId, where) => {
    const owner = payload.meta?.owner ?? '';
    const kind = payload.meta?.kind === 'command' ? 'command' : 'minion';
    if (owner === agentId) {
      // Its own agent: the middle does nothing; the bottom edge shows it under the agent.
      if (where === 'under') void shownUnder({ task_id: payload.id, kind, owner, under: agentId, name: payload.label, command: null }, agentId).catch(fail);
      return;
    }
    const pane = minionPaneOf(payload.id);
    if (kind === 'minion' && pane) {
      askHandOver({ taskPane: pane, taskName: payload.label, fromId: owner, fromName: nameOf(owner), toId: agentId, toName: nameOf(agentId) });
      return;
    }
    c.notify(t('taskdrag.refuse.belongs', { name: payload.meta?.ownerName || nameOf(owner) }));
  };

  // Empty sidebar space: the task is shown on its own (the owner stays).
  const zoneId = 'sidebar-task-own';
  useEffect(
    () =>
      registerDropZone({
        id: zoneId,
        priority: 1,
        accepts: (p) => p.kind === 'bgtask',
        getRect: () => sideRef.current?.getBoundingClientRect() ?? null,
        onDrop: (p) => {
          const owner = p.meta?.owner ?? '';
          const kind = p.meta?.kind === 'command' ? 'command' : 'minion';
          void shownUnder({ task_id: p.id, kind, owner, under: null, name: p.label, command: null }, null).catch(fail);
        },
      }),
    // The handlers read the latest props through closures of this render; the zone only needs to exist while mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sideRef, nameOf],
  );

  const own = ownRows(drawable).concat(drawable.filter((r) => r.under !== null && !nestedUnder(r)));
  const ownUnique = own.filter((r, i) => own.findIndex((x) => x.task_id === r.task_id) === i);
  return {
    rowsFor: (agentId) => taskRowsOf(drawable, agentId).flatMap((r) => (nestedUnder(r) === agentId ? [rowView(r, true)] : [])).filter((x): x is JSX.Element => x !== null),
    ownGroup:
      ownUnique.length === 0 ? null : (
        <div className="ck-sb-tasks" role="group" aria-label={t('taskdrag.group')} data-testid="sidebar-tasks-own">
          <div className="ck-sb-tasks-head">{t('taskdrag.group')}</div>
          {ownUnique.map((r) => rowView(r, false))}
        </div>
      ),
    onTaskDrop,
  };
}
