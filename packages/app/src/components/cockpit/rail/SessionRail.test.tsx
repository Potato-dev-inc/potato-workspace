// @vitest-environment jsdom
// Screen-level: the right panel as one flat column of sections, rendered through the real SessionRail.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';
import { resetTaskViews } from '../../../lib/task-view';

const chat = vi.hoisted(() => ({ current: {} as Record<string, unknown>, calls: [] as Array<[string, boolean]> }));
vi.mock('../../../hooks/useSessionChat', () => ({
  useSessionChat: (paneId: string, enabled: boolean) => {
    chat.calls.push([paneId, enabled]);
    return chat.current;
  },
}));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'feat/rail' }));
const jobs = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({
  ...(await orig<typeof import('../../../lib/pane-jobs')>()),
  usePaneJobs: () => ({ p1: jobs.list }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetTaskViews();
  chat.calls = [];
  jobs.list = [];
  chat.current = {
    model: 'model-x',
    cliVersion: '1.2.3',
    usage: { kind: 'usage', id: 'u', at: null, inputTokens: 90_000, outputTokens: 6000, contextWindow: 200_000 },
    plan: [
      { text: 'Step one', status: 'completed' },
      { text: 'Step two', status: 'pending' },
    ],
    outputs: [
      { path: '/work/shop/notes.md', tool: 'Write', wrote: true },
      { path: '/work/shop/src/app.ts', tool: 'Edit', wrote: true },
    ],
    turns: [{ steps: [{ kind: 'tool', call: { name: 'mcp__github__list_prs' } }] }],
  };
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const props = {
  paneId: 'p1',
  status: 'idle',
  cwd: '/work/shop',
  agentType: 'claude',
  agentName: 'Claude 1',
  accountLabel: null,
  readsChat: true,
  helperOf: null,
  helpers: [],
  onOpenPane: () => {},
};
const mount = async (extra: Record<string, unknown> = {}) => {
  await act(async () => root.render(<SessionRail {...props} {...extra} />));
  await act(async () => {});
};
const labels = () => [...host.querySelectorAll('.rp-sec-h button > span:first-child')].map((s) => s.textContent);

describe('SessionRail sections', () => {
  it('shows the sections in order, from the pane chat data', async () => {
    await mount();
    expect(labels()).toEqual(['Environment', 'Context', 'Plan', 'Connectors', 'Outputs', 'Changes', 'Background tasks', 'Files']);
    const text = host.textContent ?? '';
    expect(text).toContain('feat/rail');
    expect(text).toContain('48% used');
    expect(text).toContain('96k of 200k');
    expect(text).toContain('1 of 2 done');
    expect(text).toContain('notes.md');
    expect(chat.calls[0]).toEqual(['p1', true]);
  });

  it('puts no result strip, cards or boxes in the panel, and the agent is the top line', async () => {
    await mount();
    expect(host.querySelector('.ck-rail-card')).toBeNull();
    expect(host.querySelector('[data-testid="acp-result"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-top"]')!.textContent).toContain('Claude 1');
    expect(host.querySelector('[data-testid="rail-pill"]')!.textContent).toBe('Done');
  });

  it('shows every empty line for a new chat, so the panel does not jump when work starts', async () => {
    chat.current = { model: null, cliVersion: null, usage: null, plan: [], outputs: [], turns: [] };
    await mount();
    const text = host.textContent ?? '';
    expect(host.querySelector('[data-testid="rail-pill"]')!.textContent).toBe('Ready');
    for (const line of ['Nothing made yet', 'No changes yet', 'Nothing running', 'No connectors', '0% used']) expect(text).toContain(line);
    expect(labels()).not.toContain('Plan');
  });

  it('says so when the agent does not share its window', async () => {
    chat.current = { ...chat.current, usage: null };
    await mount();
    expect(host.textContent).toContain('Not shared by this agent');
  });

  it('Outputs lists made things (not code), with their kind', async () => {
    await mount();
    const out = host.querySelector('[data-testid="rail-out"]')!;
    expect(out.textContent).toContain('notes.md');
    expect(out.textContent).toContain('Note');
    expect(out.textContent).not.toContain('app.ts');
  });

  it('Connectors lists the tool servers the chat used', async () => {
    await mount();
    const con = host.querySelector('[data-testid="rail-con"]')!;
    expect(con.textContent).toContain('1 connected');
    expect(con.textContent).toContain('All working');
    act(() => con.querySelector<HTMLButtonElement>('button.rp-btn')!.click());
    expect(con.textContent).toContain('Github');
  });

  it('does not read a chat for a plain shell', async () => {
    await mount({ readsChat: false });
    expect(chat.calls[0]).toEqual(['p1', false]);
  });

  it('names the parent of a helper and opens it', async () => {
    const open = vi.fn();
    await mount({ helperOf: { parentId: 'parent', text: 'Helper of Refactor' }, onOpenPane: open });
    const link = host.querySelector<HTMLButtonElement>('.rp-helper-of')!;
    expect(link.textContent).toBe('Helper of Refactor');
    act(() => link.click());
    expect(open).toHaveBeenCalledWith('parent');
  });

  it('opens the Changes tab from the Review button only when the pane has one', async () => {
    await mount();
    expect(host.querySelector('.rp-btn-pri')).toBeNull();
    const open = vi.fn();
    await mount({ onOpenChanges: open });
    act(() => host.querySelector<HTMLButtonElement>('.rp-btn-pri')!.click());
    expect(open).toHaveBeenCalled();
  });
});

describe('the Needs you row', () => {
  it('appears only when the agent waits, and click answers', async () => {
    await mount();
    expect(host.querySelector('[data-testid="rail-needs-you"]')).toBeNull();
    const answer = vi.fn();
    await mount({ status: 'waiting_input', ask: 'Allow npm install?', onAnswer: answer });
    const row = host.querySelector<HTMLButtonElement>('[data-testid="rail-needs-you"]')!;
    expect(row.textContent).toContain('Allow npm install?');
    expect(host.querySelector('[data-testid="rail-pill"]')!.textContent).toBe('Needs you');
    act(() => row.click());
    expect(answer).toHaveBeenCalledTimes(1);
  });
});

describe('folding sections', () => {
  it('a folded section shows its one-line summary, and stays folded after a reload', async () => {
    await mount();
    const head = (id: string) => host.querySelector<HTMLButtonElement>(`[data-sec="${id}"] .rp-sec-h button`)!;
    act(() => head('ctx').click());
    expect(host.querySelector('[data-sec="ctx"] .rp-rows')).toBeNull();
    expect(host.querySelector('[data-sec="ctx"] .rp-sum')!.textContent).toBe('48%');
    expect(window.localStorage.getItem('pm.rail.closed')).toBe('ctx');
    // A new session of the app reads the list again.
    act(() => root.unmount());
    resetRailFoldForTests();
    root = createRoot(host);
    await mount();
    expect(host.querySelector('[data-sec="ctx"] .rp-rows')).toBeNull();
    expect(head('ctx').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Background tasks', () => {
  it('lists helpers with a stop square, and "Needs you" for a waiting helper', async () => {
    const stop = vi.fn(async () => {});
    await mount({
      helpers: [
        { id: 'h1', title: 'Reviewer', agent: 'Codex', agentType: 'codex', status: 'running' },
        { id: 'h2', title: 'Tests', agent: 'Claude', agentType: 'claude', status: 'waiting_input' },
        { id: 'h3', title: 'Docs', agent: 'Gemini', agentType: 'gemini', status: 'idle' },
      ],
      onStopHelper: stop,
    });
    const bg = host.querySelector('[data-testid="rail-bg"]')!;
    expect(bg.textContent).toContain('Reviewer');
    expect(bg.textContent).toContain('Needs you');
    expect(bg.textContent).toContain('1 finished');
    expect(host.querySelector('[data-sec="bg"] .rp-sum')).toBeNull();
    await act(async () => bg.querySelector<HTMLButtonElement>('[aria-label="Stop Reviewer"]')!.click());
    await act(async () => [...bg.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!.click());
    expect(stop).toHaveBeenCalledWith('h1');
  });
});

describe('Minions in Background tasks', () => {
  const minion = { id: 'm1', title: 'Reviewer', agent: 'Claude', agentType: 'claude', status: 'running', kind: 'minion' };
  const done = { id: 'm2', title: 'Old check', agent: 'Claude', agentType: 'claude', status: 'idle', kind: 'minion' };

  it('a minion pane gives a row; clicking it opens the read-only view beside the panel, with no text box', async () => {
    chat.current = { state: 'ready', reason: null, waitingFor: null, source: 'acp', model: 'haiku-x', cliVersion: null, usage: null, plan: [], outputs: [], turns: [], earlier: undefined };
    const open = vi.fn();
    await mount({ helpers: [minion], onOpenPane: open, onStopHelper: async () => {} });
    expect(host.querySelectorAll('[data-testid="rail-helper"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="rail-helper"] .rp-row-main')!.click());
    const column = host.querySelector('[data-testid="task-column"]')!;
    expect(open).not.toHaveBeenCalled();
    expect(column.querySelector('[data-testid="task-side-view"]')).not.toBeNull();
    expect(column.textContent).toContain('Reviewer');
    expect(column.textContent).toContain('Claude 1 runs this minion. You can read its work and stop it.');
    expect(column.querySelector('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]')).toBeNull();
    expect(chat.calls.some(([id, on]) => id === 'm1' && on)).toBe(true);
    // Back: the full page; close: gone.
    await act(async () => column.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
    expect(host.querySelector('[data-testid="background-page"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
  });

  it('the heading button opens the page: Running as cards, Finished folded, the bin clears finished, fill toggles', async () => {
    jobs.list = [{ pid: 7, parentPid: 1, name: 'npm test', command: 'npm test -- upload', startedAtMs: Date.now() - 5000, ports: [] }];
    await mount({ helpers: [minion, done], onStopHelper: async () => {} });
    await act(async () => host.querySelector<HTMLButtonElement>('.rp-sec-open')!.click());
    const page = host.querySelector('[data-testid="background-page"]')!;
    expect(page.textContent).toContain('Running 2');
    expect(page.querySelectorAll('[data-testid="task-group"]')).toHaveLength(2);
    expect(page.textContent).toContain('Finished 1');
    await act(async () => page.querySelector<HTMLButtonElement>('.tk-sum')!.click());
    expect(page.querySelector('[data-testid="task-job"]')).not.toBeNull();
    const fill = host.querySelector<HTMLButtonElement>('[aria-label="Fill the window"]')!;
    await act(async () => fill.click());
    expect(host.querySelector('[data-testid="task-column"]')!.getAttribute('data-full')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back to the side"]')!.click());
    expect(host.querySelector('[data-testid="task-column"]')!.getAttribute('data-full')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Clear finished"]')!.click());
    expect(host.querySelector('[data-testid="background-page"]')!.textContent).not.toContain('Finished');
    expect(host.querySelector('[data-testid="rail-bg"]')!.textContent).not.toContain('finished');
  });

  it('a helper (One type) still opens its own pane', async () => {
    const open = vi.fn();
    await mount({ helpers: [{ ...minion, kind: 'helper' }], onOpenPane: open });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="rail-helper"] .rp-row-main')!.click());
    expect(open).toHaveBeenCalledWith('m1');
    expect(host.querySelector('[data-testid="task-column"]')).toBeNull();
  });
});

describe('Environment', () => {
  it('shows where the chat runs, the folder, the branch and the copy state', async () => {
    await mount({ copy: { kind: 'git' } });
    const env = host.querySelector('[data-testid="rail-env"]')!;
    expect(env.textContent).toContain('This computer');
    expect(env.textContent).toContain('shop');
    expect(env.textContent).toContain('feat/rail');
    expect(env.textContent).toContain('On · copy');
  });
});

describe('Remote control: how far a phone can go', () => {
  it('shows Watch, Answer and Full under the switch when a phone is paired and remote is on, and sets the level', async () => {
    const set = vi.fn(async (_id: string, change: { level?: string }) => ({ remote: true, level: change.level ?? 'full' }) as never);
    const api = { get: async () => ({ remote: true, level: 'full' }) as never, set, phones: async () => [{ id: 'd1', name: 'Phone', expired: false, caps: [] }] as never };
    const { EnvironmentSection } = await import('./EnvironmentSection');
    await act(async () => root.render(<EnvironmentSection paneId="p1" cwd="/work/shop" runsOn={null} branch={null} copy={null} api={api} />));
    await act(async () => {});
    const group = host.querySelector('[data-testid="rail-remote-level"]')!;
    // One compact dropdown, not three buttons in a row.
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Phone control: Full']);
    expect(group.querySelector('[role="radiogroup"]')).toBeNull();
    await act(async () => group.querySelector('button')!.click());
    const menu = document.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Watch', 'Answer', 'Full']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true']);
    await act(async () => items[0].click());
    expect(set).toHaveBeenCalledWith('p1', { level: 'watch' });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(group.textContent).toContain('Phone control: Watch');
    // Escape closes the menu without changing anything.
    await act(async () => group.querySelector('button')!.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(set).toHaveBeenCalledTimes(1);
  });
});
