import { afterEach, describe, expect, it } from 'vitest';
import { parseJobTask } from '../components/cockpit/useSidebarTasks';
import { jobTaskId, minionPaneOf, minionTaskId, ownRows, placeTask, removeTaskFromSidebar, setTaskSidebarApiForTest, showTaskInSidebar, taskRowsOf, type TaskPlacement, type TaskSidebarApi } from './task-sidebar';

const row = (id: string, under: string | null): TaskPlacement => ({ task_id: id, kind: 'minion', owner: 'a1', under, name: id, command: null });

afterEach(() => setTaskSidebarApiForTest(null, []));

describe('task ids', () => {
  it('a job id keeps the pane, the process and its start, even when the pane id holds colons', () => {
    expect(parseJobTask(jobTaskId('pane-3', 77, 1234))).toEqual({ owner: 'pane-3', pid: 77, startedAtMs: 1234 });
    expect(parseJobTask(jobTaskId('a:b', 5, 9))).toEqual({ owner: 'a:b', pid: 5, startedAtMs: 9 });
    expect(parseJobTask('minion:p1')).toBeNull();
    expect(parseJobTask('job:broken')).toBeNull();
    expect(minionPaneOf(minionTaskId('p9'))).toBe('p9');
    expect(minionPaneOf('job:p:1:2')).toBeNull();
  });
});

describe('the sidebar task list', () => {
  const fail: TaskSidebarApi = {
    get: async () => [],
    show: async () => {
      throw new Error('refused');
    },
    place: async () => {
      throw new Error('refused');
    },
    remove: async () => {
      throw new Error('refused');
    },
    reorder: async () => [],
  };

  it('splits rows into the ones under an agent and the ones on their own', () => {
    const list = [row('minion:a', 'a1'), row('minion:b', null), row('minion:c', 'a2')];
    expect(taskRowsOf(list, 'a1').map((r) => r.task_id)).toEqual(['minion:a']);
    expect(ownRows(list).map((r) => r.task_id)).toEqual(['minion:b']);
  });

  it('a refused change puts the list back as it was', async () => {
    setTaskSidebarApiForTest(fail, [row('minion:a', 'a1')]);
    await expect(placeTask('minion:a', null)).rejects.toThrow('refused');
    await expect(removeTaskFromSidebar('minion:a')).rejects.toThrow('refused');
    await expect(showTaskInSidebar(row('minion:z', null))).rejects.toThrow('refused');
    // Read back through a good "get": the failed calls changed nothing.
    const { reloadTaskSidebar } = await import('./task-sidebar');
    setTaskSidebarApiForTest({ ...fail, get: async () => [row('minion:a', 'a1')] }, []);
    await reloadTaskSidebar();
    expect(taskRowsOf([row('minion:a', 'a1')], 'a1')).toHaveLength(1);
  });
});
