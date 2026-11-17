// @vitest-environment jsdom
// A task that sits in the sidebar, opened in the main area: a minion's view is read-only (no message box, no Allow buttons) and
// can be stopped; a command shows what it runs with Stop; a row that was put back (or whose pane closed) leaves the main area.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useEnglish } from '../../i18n/test-utils';
import { setTaskSidebarApiForTest, type TaskPlacement } from '../../lib/task-sidebar';
import { TaskMainView } from './TaskMainView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const chat = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../hooks/useSessionChat', () => ({ useSessionChat: () => chat.current }));

const MINION: TaskPlacement = { task_id: 'minion:m1', kind: 'minion', owner: 'a1', under: 'a1', name: 'Reviewer', command: null };
const JOB: TaskPlacement = { task_id: 'job:a1:7:5000', kind: 'command', owner: 'a1', under: null, name: 'Dev server', command: 'npm run dev' };

let host: HTMLDivElement;
let root: Root;
const interrupt = vi.fn();
const gone = vi.fn();
const fakeApi = (withMinion = true): CockpitApi => {
  const panes = [
    { info: { id: 'a1', agent_type: 'codex', created_at: 1, cwd: 'C:\\p', parent_pane_id: null } as unknown as PaneInfo, status: 'idle' },
    ...(withMinion ? [{ info: { id: 'm1', agent_type: 'claude', created_at: 1000, cwd: 'C:\\p', parent_pane_id: 'a1', started_as: 'minion' } as unknown as PaneInfo, status: 'running' }] : []),
  ];
  return { registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])) }, names: new Map([['a1', 'Alpha'], ['m1', 'Reviewer']]), interrupt } as unknown as CockpitApi;
};

beforeEach(() => {
  useEnglish();
  interrupt.mockClear();
  gone.mockClear();
  chat.current = { state: 'ready', reason: null, waitingFor: null, source: 'acp', model: 'm', cliVersion: null, turns: [], earlier: undefined };
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setTaskSidebarApiForTest(null, []);
});

const mount = async (taskId: string, c = fakeApi()) => {
  await act(async () => root.render(<TaskMainView c={c} taskId={taskId} onGone={gone} jobsApi={{ all: async () => ({}), stop: async () => {} }} />));
};

describe('a task opened in the main area', () => {
  it('a minion is read-only: no message box, no buttons that answer for it, and Stop asks first', async () => {
    setTaskSidebarApiForTest({ get: async () => [MINION], show: async () => [], place: async () => [], remove: async () => [], reorder: async () => [] }, [MINION]);
    await mount(MINION.task_id);
    expect(host.querySelector('[data-testid="task-main"]')?.textContent).toContain('Reviewer');
    expect(host.querySelector('[data-testid="task-main"]')?.textContent).toContain('minion');
    expect(host.querySelector('textarea, [contenteditable="true"], input[type="text"]')).toBeNull();
    expect(host.textContent).toContain('Alpha runs this minion');
    // Stop: the first press asks.
    const stop = host.querySelector<HTMLButtonElement>('.rp-stop')!;
    await act(async () => stop.click());
    expect(interrupt).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('.rp-mini.is-danger')!.click());
    expect(interrupt).toHaveBeenCalledWith('m1');
    expect(gone).not.toHaveBeenCalled();
  });

  it('a command shows its name and what it runs', async () => {
    setTaskSidebarApiForTest({ get: async () => [JOB], show: async () => [], place: async () => [], remove: async () => [], reorder: async () => [] }, [JOB]);
    await mount(JOB.task_id);
    expect(host.querySelector('[data-testid="task-main"]')?.textContent).toContain('Dev server');
    expect(host.querySelector('[data-testid="dock-terminal"]')?.textContent).toContain('npm run dev');
  });

  it('leaves the main area when the row goes back to Background tasks, or its pane closes', async () => {
    setTaskSidebarApiForTest({ get: async () => [], show: async () => [], place: async () => [], remove: async () => [], reorder: async () => [] }, []);
    await mount(MINION.task_id);
    expect(gone).toHaveBeenCalled();
    gone.mockClear();
    setTaskSidebarApiForTest({ get: async () => [MINION], show: async () => [], place: async () => [], remove: async () => [], reorder: async () => [] }, [MINION]);
    await mount(MINION.task_id, fakeApi(false));
    expect(gone).toHaveBeenCalled();
  });
});
