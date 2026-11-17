// @vitest-environment jsdom
// Screen-level: the commands in Background tasks, rendered through the real SessionRail: a terminal an agent started, a
// command a child agent ran (shown under its parent as "by <name>"), the stop question, the output view and the finished list.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import type { FinishedMap, JobsApi, JobsMap, PaneJob } from '../../../lib/pane-jobs';
import { resetTaskViews } from '../../../lib/task-view';
import { resetRailFoldForTests } from './railFold';
import type { CommandOwner } from './helperRows';
import { SessionRail } from './SessionRail';

vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ model: null, cliVersion: null, usage: null, plan: [], outputs: [], turns: [] }) }));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'main' }));
const store = vi.hoisted(() => ({ jobs: {} as Record<string, unknown[]>, finished: {} as Record<string, unknown[]> }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({
  ...(await orig<typeof import('../../../lib/pane-jobs')>()),
  usePaneJobs: () => store.jobs,
  useFinishedCommands: () => store.finished,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetTaskViews();
  store.jobs = {};
  store.finished = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NOW = Date.now();
const job = (over: Partial<PaneJob>): PaneJob => ({ pid: 100, parentPid: 1, name: 'node', command: 'node server.js', startedAtMs: NOW - 90_000, ports: [], ...over });
const api = (): JobsApi & { stop: ReturnType<typeof vi.fn>; stopTerminal: ReturnType<typeof vi.fn>; output: ReturnType<typeof vi.fn> } => ({
  all: vi.fn(async () => ({}) as JobsMap),
  finished: vi.fn(async () => ({}) as FinishedMap),
  stop: vi.fn(async () => {}),
  stopTerminal: vi.fn(async () => {}),
  output: vi.fn(async () => ({ lines: ['VITE v5 ready in 312 ms', '  Local: http://localhost:5173/'], nextCursor: 2, state: 'running' as const, ports: [5173] })),
});
const owners: CommandOwner[] = [
  { id: 'p1', name: 'Claude 1', agentType: 'claude', status: 'idle', self: true },
  { id: 'm1', name: 'Reviewer', agentType: 'claude', status: 'running', self: false },
];
const props = { paneId: 'p1', status: 'idle', cwd: '/work', agentType: 'claude', agentName: 'Claude 1', accountLabel: null, readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };
const mount = async (extra: Record<string, unknown> = {}) => {
  await act(async () => root.render(<SessionRail {...props} {...extra} />));
  await act(async () => {});
};
const rows = () => [...host.querySelectorAll('[data-testid="background-job"]')];
const click = (el: Element | null) => act(() => void (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })));
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

describe('commands in Background tasks (through SessionRail)', () => {
  it('lists a terminal the agent started with its name and port, and Stop asks once', async () => {
    const a = api();
    store.jobs = { p1: [job({ pid: 7, source: 'terminal', terminalId: 'term-1', title: 'Dev server', ports: [5173], command: 'npm run dev' })] };
    await mount({ jobsApi: a, owners: [owners[0]] });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Dev server');
    expect(rows()[0].textContent).toContain(':5173');
    expect(rows()[0].querySelector('[data-testid="command-by"]'), 'with only its own agent listed there is no "by"').toBeNull();
    // The full command is in the tip only.
    expect(rows()[0].getAttribute('title')).toBe('npm run dev');
    click(host.querySelector('.rp-stop'));
    expect(host.querySelector('[aria-label="Stop this one?"]')).not.toBeNull();
    click(button('No'));
    expect(a.stopTerminal).not.toHaveBeenCalled();
    click(host.querySelector('.rp-stop'));
    await act(async () => click(button('Yes')));
    expect(a.stopTerminal).toHaveBeenCalledTimes(1);
    expect(a.stopTerminal).toHaveBeenCalledWith('term-1');
    expect(a.stop).not.toHaveBeenCalled();
  });

  it('shows a command a child agent ran under its parent, marked "by <name>", and stops that child\'s process', async () => {
    const a = api();
    store.jobs = {
      p1: [job({ pid: 7, source: 'terminal', terminalId: 'term-1', title: 'Dev server', ports: [5173] })],
      m1: [job({ pid: 9, startedAtMs: NOW - 40_000, kind: 'test', command: 'npm test', name: 'node', source: 'process' })],
    };
    await mount({ jobsApi: a, owners });
    expect(rows()).toHaveLength(2);
    const child = rows().find((r) => r.textContent?.includes('Run the tests'))!;
    expect(child.querySelector('[data-testid="command-by"]')?.textContent).toBe('by Reviewer');
    // Once another agent has a row, every row says who ran it.
    expect(rows().find((r) => r.textContent?.includes('Dev server'))!.querySelector('[data-testid="command-by"]')?.textContent).toBe('by Claude 1');
    // The agent is waiting on a command it ran itself: the question says so.
    click(child.querySelector('.rp-stop'));
    expect(child.querySelector('[aria-label="Stop this command? Reviewer is waiting for it."]')).not.toBeNull();
    await act(async () => click(button('Yes')));
    expect(a.stop).toHaveBeenCalledWith('m1', 9, NOW - 40_000);
  });

  it('a row the app cannot stop (seen only in the chat) has no Stop square', async () => {
    store.jobs = { p1: [job({ pid: 0, source: 'chat', callId: 'c1', stoppable: false, command: 'npm run build', kind: 'build' })] };
    await mount({ jobsApi: api(), owners: [owners[0]] });
    expect(rows()[0].textContent).toContain('Build');
    expect(rows()[0].querySelector('.rp-stop')).toBeNull();
  });

  it('shows no row when the backend lists none (a one second command never makes a row)', async () => {
    store.jobs = {};
    await mount({ jobsApi: api(), owners });
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain('Nothing running');
  });

  it('opens a running terminal\'s output in the details column, read only, with the command in a fold', async () => {
    const a = api();
    store.jobs = { p1: [job({ pid: 7, source: 'terminal', terminalId: 'term-1', title: 'Dev server', ports: [5173], command: 'npm run dev' })] };
    await mount({ jobsApi: a, owners: [owners[0]] });
    click(rows()[0].querySelector('button.rp-open'));
    await act(async () => {});
    const pane = host.querySelector('[data-testid="dock-terminal"]')!;
    expect(pane).not.toBeNull();
    expect(a.output).toHaveBeenCalledWith('term-1', undefined);
    expect(host.querySelector('[data-testid="dock-output"]')!.textContent).toContain('VITE v5 ready in 312 ms');
    expect(pane.querySelector('summary')!.textContent).toBe('Show the command');
    expect(pane.querySelector('input, textarea')).toBeNull();
    expect(pane.querySelector('.rp-stop, .tk-foot .rp-stop')).not.toBeNull();
  });

  it('lists finished commands (the last ones), "by <name>" for a child, and opens a kept output', async () => {
    const a = api();
    a.output.mockResolvedValue({ lines: ['3 passed'], nextCursor: 1, state: 'exited', exitCode: 0 });
    store.finished = {
      m1: [{ id: 'terminal:term-2', name: 'node', command: 'npm test', kind: 'test', title: undefined, startedAtMs: NOW - 60_000, endedAtMs: NOW - 48_000, state: 'done', terminalId: 'term-2' }],
      p1: [{ id: 'call:c9', name: 'cargo', command: 'cargo build', kind: 'build', startedAtMs: NOW - 120_000, endedAtMs: NOW - 100_000, state: 'failed' }],
    };
    store.jobs = { p1: [job({ pid: 7, source: 'terminal', terminalId: 'term-1', title: 'Dev server' })] };
    await mount({ jobsApi: a, owners });
    expect(host.textContent).toContain('2 finished');
    click(host.querySelector('button.rp-more'));
    const done = [...host.querySelectorAll('[data-testid="rail-command-done"]')];
    expect(done.map((d) => d.textContent)).toEqual([expect.stringContaining('Run the tests'), expect.stringContaining('Build')]);
    expect(done[0].textContent).toContain('by Reviewer');
    expect(done[0].textContent).toContain('12s');
    expect(done[1].textContent).toContain('Failed');
    click(done[0]);
    await act(async () => {});
    expect(host.querySelector('[data-testid="dock-output"]')!.textContent).toContain('3 passed');
    // It is over: no Stop and no "Running".
    expect(host.querySelector('[data-testid="dock-terminal"]')!.getAttribute('data-live')).toBe('false');
  });

  it('says plainly that the output of a command that is not a terminal is not kept', async () => {
    store.jobs = { m1: [job({ pid: 9, source: 'process', kind: 'build', command: 'npm run build' })] };
    await mount({ jobsApi: api(), owners });
    click(rows()[0].querySelector('button.rp-open'));
    await act(async () => {});
    expect(host.querySelector('[data-testid="dock-terminal"]')!.textContent).toContain('The output of this command is not kept.');
  });
});
