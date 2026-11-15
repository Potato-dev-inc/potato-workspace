// @vitest-environment jsdom
// Screen-level: "Keep all" in the right panel's Changes section, clicked through the real SessionRail.
// A chat on a copy keeps the copy into the project (the existing merge); a chat working in the project marks the
// turn's files as kept. Both show "Kept"; a refusal is shown as a sentence and never swallowed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { cockpitApi, type WorktreeItem } from '../../../lib/cockpit-api';
import { resetReviewMarks } from '../../../lib/turn-review';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';

const REVIEW = {
  turn: 2,
  beforeId: '3',
  afterId: '4',
  truncated: false,
  files: [{ path: 'src/AgentsSection.test.tsx', status: 'M', added: 8, deleted: 8, binary: false, blob: 'ba' }],
};
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd: string) => (cmd === 'checkpoint_turn_review' ? REVIEW : null) }));
vi.mock('../../../hooks/useSessionChat', () => ({
  useSessionChat: () => ({ model: null, cliVersion: null, usage: null, plan: [], outputs: [], turns: [{ steps: [] }] }),
}));
vi.mock('./usePaneBranch', () => ({ usePaneBranch: () => 'feat/x' }));
vi.mock('../../../lib/pane-jobs', async (orig) => ({ ...(await orig<typeof import('../../../lib/pane-jobs')>()), usePaneJobs: () => ({}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COPY: WorktreeItem = { handle: 'run-1', branch: 'pm/run-1', base: 'main', repo: 'C:/proj', path: 'C:/proj/.wt/run-1', exists: true, state: 'unreviewed', summary: null };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetReviewMarks();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const mount = async (extra: Record<string, unknown> = {}) => {
  const props = { paneId: 'p1', status: 'idle', cwd: 'C:/proj', agentType: 'claude', agentName: 'Claude 1', accountLabel: null, readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {}, onOpenChanges: () => {} };
  await act(async () => root.render(<SessionRail {...props} {...extra} />));
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
};
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => {
  expect(el).toBeDefined();
  await act(async () => (el as HTMLElement).click());
  await act(async () => {});
};

describe('Keep all in the right panel', () => {
  it('in the project itself: marks the file as kept and the row says Kept', async () => {
    await mount();
    expect(host.querySelector('[data-testid="rail-row-kept"]')).toBeNull();
    await click(button('Keep all'));
    expect(host.querySelector('[data-testid="rail-row-kept"]')?.textContent).toBe('Kept');
    expect(button('Keep all')).toBeUndefined();
  });

  it('on a copy: asks once, then merges the copy into the project and says Kept', async () => {
    const merge = vi.spyOn(cockpitApi, 'worktreeMerge').mockResolvedValue({ merged: true, into: 'main', merge_commit: 'abc', files: ['a'] } as never);
    const notify = vi.fn();
    await mount({ worktree: COPY, onNotify: notify });
    await click(button('Keep all'));
    expect(merge).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Bring 1 file into main? This closes the copy.');
    await click(button('Keep'));
    expect(merge).toHaveBeenCalledWith('C:/proj', 'run-1');
    expect(notify).toHaveBeenCalledWith('Kept in main.');
    expect(host.querySelector('[data-testid="rail-row-kept"]')?.textContent).toBe('Kept');
  });

  it('on a copy: a refusal shows as a plain sentence, and nothing is marked kept', async () => {
    vi.spyOn(cockpitApi, 'worktreeMerge').mockRejectedValue(new Error('ORIGIN_DIRTY_OVERLAP: Your project has local edits (a.ts)'));
    await mount({ worktree: COPY });
    await click(button('Keep all'));
    await click(button('Keep'));
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Your project has unsaved changes to the same files. Save or undo them first.');
    expect(host.querySelector('[data-testid="rail-row-kept"]')).toBeNull();
    expect(button('Keep all')).toBeDefined();
  });

  it('on a copy: any other error is shown without its code', async () => {
    vi.spyOn(cockpitApi, 'worktreeMerge').mockRejectedValue('FENCE_REFUSED: This change touches a protected file.');
    await mount({ worktree: COPY });
    await click(button('Keep all'));
    await click(button('Keep'));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This change touches a protected file.');
  });
});
