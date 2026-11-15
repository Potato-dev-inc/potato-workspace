// @vitest-environment jsdom
// The Routines page as a screen: the list, the waiting line, the limit, the new routine form and the buttons.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoutinesView, WorkflowView } from '../../../lib/routines';
import { RoutinesPage } from './RoutinesPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const morning: WorkflowView = {
  id: 'rt-00000001',
  name: 'Morning check',
  kind: 'routine',
  enabled: true,
  days: [1, 2, 3, 4, 5],
  time: '09:00',
  paneId: null,
  onlyIfOk: false,
  steps: [
    { kind: 'start_agent', agent: 'claude', project: 'C:/work/shop', text: 'Look at yesterday', separateCopy: true },
    { kind: 'wait', agent: null, project: null, text: null, separateCopy: false },
  ],
  nextMs: Date.now() + 3_600_000,
  lastRunMs: null,
  lastResult: null,
  pausedNote: null,
  running: false,
};
const chain: WorkflowView = { ...morning, id: 'rt-00000002', name: 'Then: send a message', kind: 'chain', days: [], time: null, paneId: 'p1', onlyIfOk: true, nextMs: null, steps: [{ kind: 'follow_up', agent: null, project: null, text: 'run the tests', separateCopy: false }] };

let view: RoutinesView;
let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
}

async function open() {
  await act(async () => {
    root.render(<RoutinesPage onClose={() => {}} defaultProject="C:/work/shop" />);
  });
  await flush();
}

const click = (label: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
  expect(button, `button "${label}"`).toBeTruthy();
  act(() => button!.click());
};

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  view = { limit: null, running: 0, workflows: [], queue: [], runs: [] };
  invoke.mockImplementation(async (name: string) => {
    if (name === 'routines_view') return view;
    if (name === 'routines_agents') return [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
    return undefined;
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  invoke.mockReset();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('RoutinesPage', () => {
  it('shows the empty state with a New routine button', async () => {
    await open();
    expect(host.querySelector('[data-testid="routines-empty"]')).toBeTruthy();
    expect(host.textContent).toContain('No routines yet');
    expect(host.textContent).toContain('No chains');
  });

  it('lists a routine in plain words with its steps and next run', async () => {
    view.workflows = [morning, chain];
    await open();
    const row = host.querySelector('[data-testid="workflow-rt-00000001"]')!;
    expect(row.textContent).toContain('Morning check');
    expect(row.textContent).toContain('Weekdays at 09:00');
    expect(row.textContent).toContain('Claude Code works in shop');
    expect(row.textContent).toContain('Wait for it to finish');
    expect(row.textContent).toContain('Next:');
    const chainRow = host.querySelector('[data-testid="workflow-rt-00000002"]')!;
    expect(chainRow.textContent).toContain('When a chat finishes well');
    expect(chainRow.textContent).toContain('Send: run the tests');
  });

  it('shows the waiting line with the running count and each waiting run in order', async () => {
    view.limit = 3;
    view.running = 3;
    view.queue = [
      { runId: 'rr-00000001', name: 'Morning check', position: 1 },
      { runId: 'rr-00000002', name: 'Nightly tidy', position: 2 },
    ];
    await open();
    const queue = host.querySelector('[data-testid="routines-queue"]')!;
    expect(queue.textContent).toContain('Waiting for a free slot (3 running)');
    expect(queue.textContent).toContain('Number 1 in line');
    expect(queue.textContent).toContain('Number 2 in line');
    click('Stop');
    expect(invoke).toHaveBeenCalledWith('routines_stop_run', { runId: 'rr-00000001' });
  });

  it('the limit is off by default and the choice is sent as a number or null', async () => {
    await open();
    const select = host.querySelector<HTMLSelectElement>('#routines-limit')!;
    expect(select.value).toBe('');
    await act(async () => {
      select.value = '2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(invoke).toHaveBeenCalledWith('routines_set_limit', { limit: 2 });
  });

  it('Run now, Turn off and Delete (after a yes) call their commands', async () => {
    view.workflows = [morning];
    await open();
    click('Run now');
    await flush();
    expect(invoke).toHaveBeenCalledWith('routines_run_now', { id: 'rt-00000001' });
    click('Turn off');
    await flush();
    expect(invoke).toHaveBeenCalledWith('routines_set_enabled', { id: 'rt-00000001', enabled: false });
    click('Delete');
    expect(invoke).not.toHaveBeenCalledWith('routines_delete', expect.anything());
    expect(host.textContent).toContain('Delete "Morning check"?');
    click('Yes, delete');
    await flush();
    expect(invoke).toHaveBeenCalledWith('routines_delete', { id: 'rt-00000001' });
  });

  it('the new routine form saves a schedule with steps: start the agent, wait, tell me', async () => {
    await open();
    click('New routine');
    const form = host.querySelector('form[aria-label="New routine"]')!;
    expect(form).toBeTruthy();
    const set = (el: Element, value: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      set(form.querySelector('input[maxlength="60"]')!, 'Morning check');
      set(form.querySelector('textarea')!, 'Look at yesterday');
    });
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    const created = invoke.mock.calls.find((c) => c[0] === 'routines_create');
    expect(created).toBeTruthy();
    expect(created![1]).toEqual({
      workflow: {
        name: 'Morning check',
        trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '09:00' },
        steps: [
          { kind: 'start_agent', agent: 'claude', project: 'C:/work/shop', task: 'Look at yesterday', separate_copy: true },
          { kind: 'wait' },
          { kind: 'notify', text: 'Routine finished: Morning check' },
        ],
      },
    });
    expect(host.querySelector('form[aria-label="New routine"]')).toBeNull();
  });

  it('a refusal from the engine shows as one sentence on the form', async () => {
    invoke.mockImplementation(async (name: string) => {
      if (name === 'routines_view') return view;
      if (name === 'routines_agents') return [{ id: 'claude', label: 'Claude Code' }];
      if (name === 'routines_create') throw 'Give it a name.';
      return undefined;
    });
    await open();
    click('New routine');
    const form = host.querySelector('form[aria-label="New routine"]')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Give it a name.');
  });

  it('recent runs say why one ran late or stopped', async () => {
    view.runs = [
      { id: 'rr-00000001', workflowId: 'rt-00000001', name: 'Morning check', state: 'running', step: 1, stepCount: 2, noteCode: 'late', noteDetail: null, dueMs: Date.now() - 3_600_000, createdMs: Date.now(), finishedMs: null },
      { id: 'rr-00000002', workflowId: 'rt-00000001', name: 'Morning check', state: 'failed', step: 0, stepCount: 2, noteCode: 'refused', noteDetail: 'That folder is not a project.', dueMs: null, createdMs: Date.now() - 86_400_000, finishedMs: Date.now() },
    ];
    await open();
    expect(host.textContent).toContain('Ran late: your computer was off at');
    expect(host.textContent).toContain('It could not start. That folder is not a project.');
    expect(host.textContent).toContain('Step 2 of 2');
  });
});
