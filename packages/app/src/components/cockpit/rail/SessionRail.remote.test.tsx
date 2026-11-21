// @vitest-environment jsdom
// Screen-level: the right panel of a chat that runs on another computer (SSH) shows no file, change, output or branch view built
// from this PC's disk, and says so in one plain sentence. A chat on this PC keeps every section.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';
import { resetTaskViews } from '../../../lib/task-view';
import { markRemotePane } from '../../../lib/remotePanes';

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

describe('SessionRail for a chat on another computer', () => {
  it('shows the plain note and none of the sections that read the folder of this PC', async () => {
    markRemotePane('r1', 'ssh-1', 'Build box');
    await mount({ paneId: 'r1', cwd: '/srv/app' });
    const note = host.querySelector('[data-testid="rail-remote-note"]');
    expect(note?.textContent).toBe('Not available on this computer yet: outputs, review, editing and committing on Build box. Here you can look at its files, branch and changes.');
    for (const id of ['rail-env', 'rail-out', 'rail-chg', 'rail-files']) expect(host.querySelector(`[data-testid="${id}"]`), id).toBeNull();
    // What is the agent's own stays: context, plan.
    expect(host.querySelector('[data-testid="rail-ctx"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-plan"]')).not.toBeNull();
  });

  it('a chat on this PC keeps the folder sections and no note', async () => {
    await mount();
    expect(host.querySelector('[data-testid="rail-remote-note"]')).toBeNull();
    expect(host.querySelector('[data-testid="rail-env"]')).not.toBeNull();
  });
});
