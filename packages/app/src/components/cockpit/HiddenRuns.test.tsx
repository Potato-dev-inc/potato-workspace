// @vitest-environment jsdom
// The Inbox card for a helper that ran with no pane: it names the agent and the task, follows the run to its end
// and can be dismissed. A visible helper has no card (it is a pane in the sidebar).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HiddenRun, HiddenRunsApi } from '../../lib/hiddenRuns';
import { hiddenRunState } from '../../lib/hiddenRuns';
import { HiddenRuns } from './HiddenRuns';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (over: Partial<HiddenRun> = {}): HiddenRun => ({
  handle: 'h1',
  agent_type: 'claude',
  task: 'count the files in src',
  project: 'D:/work/shop',
  status: 'running',
  started_at_ms: 1,
  finished_at_ms: null,
  ...over,
});

function fakeApi(initial: HiddenRun[]) {
  let rows = initial;
  let notify: () => void = () => undefined;
  const api: HiddenRunsApi = {
    list: vi.fn(async () => rows),
    dismiss: vi.fn(async (handle: string) => {
      rows = rows.filter((r) => r.handle !== handle);
    }),
    watch: (onChange) => {
      notify = onChange;
      return () => undefined;
    },
  };
  return { api, set: (next: HiddenRun[]) => ((rows = next), notify()) };
}

let host: HTMLDivElement;
let root: Root;

async function render(api: HiddenRunsApi) {
  await act(async () => root.render(<HiddenRuns api={api} />));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('HiddenRuns', () => {
  it('shows nothing while no helper ran hidden', async () => {
    await render(fakeApi([]).api);
    expect(host.querySelector('[data-testid="hidden-run"]')).toBeNull();
    expect(host.textContent).toBe('');
  });

  it('names the agent and the task of a hidden helper in plain words', async () => {
    await render(fakeApi([run()]).api);
    const card = host.querySelector('[data-testid="hidden-run"]');
    expect(card?.textContent).toContain('Claude helper ran with no window');
    expect(card?.textContent).toContain('count the files in src');
    expect(card?.textContent).toContain('Running with no window');
    expect(host.textContent).not.toContain('Claude Code');
  });

  it('follows the run from running to finished', async () => {
    const fake = fakeApi([run()]);
    await render(fake.api);
    await act(async () => {
      fake.set([run({ status: 'done', finished_at_ms: 9 })]);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="hidden-run"]')?.getAttribute('data-status')).toBe('done');
    expect(host.textContent).toContain('Finished');
  });

  it('drops a card when it is dismissed', async () => {
    const fake = fakeApi([run(), run({ handle: 'h2', task: 'second' })]);
    await render(fake.api);
    const dismiss = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!;
    await act(async () => dismiss.click());
    expect(fake.api.dismiss).toHaveBeenCalledWith('h1');
    expect(host.querySelectorAll('[data-testid="hidden-run"]')).toHaveLength(1);
    expect(host.textContent).toContain('second');
  });

  it('has a sentence for every status', () => {
    for (const status of ['running', 'needs_input', 'done', 'failed', 'cancelled'] as const) {
      expect(hiddenRunState(run({ status })).length).toBeGreaterThan(3);
    }
  });
});
