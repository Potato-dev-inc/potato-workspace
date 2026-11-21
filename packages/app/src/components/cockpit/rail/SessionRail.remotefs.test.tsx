// @vitest-environment jsdom
// Screen-level: the right panel of a chat that runs on another computer (SSH) shows that project's branch, its changed files and its
// file tree, read only, from a mocked backend. Nothing in it writes (no stage, commit, edit or create), a name from the far machine is
// shown as text, and nothing polls.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { SessionRail } from './SessionRail';
import { resetRailFoldForTests } from './railFold';
import { resetTaskViews } from '../../../lib/task-view';
import { markRemotePane } from '../../../lib/remotePanes';
import { resetFileTabs, usePaneFiles } from '../../../lib/file-tabs';
import { setLanguagePref } from '../../../i18n';
import type { FarListing, FarStatus, RemoteFsApi } from '../../../lib/remoteFs';

vi.mock('../../../hooks/useSessionChat', () => ({ useSessionChat: () => ({ model: 'm', cliVersion: '1', usage: null, plan: [], outputs: [], turns: [] }) }));
const branchCalls = vi.hoisted(() => ({ enabled: [] as boolean[] }));
vi.mock('./usePaneBranch', () => ({
  usePaneBranch: (_p: string, _s: string, enabled: boolean) => {
    branchCalls.enabled.push(enabled);
    return enabled ? 'local-branch' : null;
  },
}));
vi.mock('../../../lib/pane-jobs', async (orig) => ({ ...(await orig<typeof import('../../../lib/pane-jobs')>()), usePaneJobs: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOSTILE = '<img src=x onerror=alert(1)>.txt';
const STATUS: FarStatus = {
  branch: 'feat/x',
  detached: false,
  unborn: false,
  ahead: 1,
  behind: 0,
  gone: false,
  more: false,
  changes: [
    { path: 'src/a.ts', kind: 'modified', staged: false },
    { path: 'docs/new <b>file</b>.md', kind: 'new', staged: false },
    { path: 'b.ts', kind: 'added', staged: true },
  ],
};
const ROOT: FarListing = {
  path: '',
  more: false,
  skipped: 2,
  entries: [
    { name: 'src', kind: 'dir' },
    { name: 'README.md', kind: 'file' },
    { name: HOSTILE, kind: 'file' },
    { name: 'shortcut', kind: 'link' },
  ],
};

function fakeApi(over: Partial<RemoteFsApi> = {}) {
  const calls: string[] = [];
  const api: RemoteFsApi = {
    status: vi.fn(async (_p, fresh) => {
      calls.push(`status:${fresh ? 'fresh' : 'cached'}`);
      return STATUS;
    }),
    list: vi.fn(async (_p, path, fresh) => {
      calls.push(`list:${path}:${fresh ? 'fresh' : 'cached'}`);
      return path === '' ? ROOT : { path, more: false, skipped: 0, entries: [{ name: 'a.ts', kind: 'file' as const }] };
    }),
    read: vi.fn(async () => {
      throw new Error('not used here');
    }),
    ...over,
  };
  return { api, calls };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetTaskViews();
  resetFileTabs();
  branchCalls.enabled = [];
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const props = { paneId: 'p1', status: 'idle', cwd: '\0ssh://h1/srv/app', agentType: 'claude', agentName: 'Claude 1', accountLabel: null, readsChat: true, helperOf: null, helpers: [], onOpenPane: () => {} };
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const mount = async (extra: Record<string, unknown>) => {
  await act(async () => root.render(<SessionRail {...props} {...extra} />));
  await flush();
};

describe('the right panel of a chat on another computer', () => {
  it('shows the branch, the changes and the file tree from the backend, and nothing that writes', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    const { api } = fakeApi();
    await mount({ remoteFs: api });
    expect(q('rail-remote-env')?.textContent).toContain('Build box');
    expect(q('rail-remote-env')?.textContent).toContain('app');
    expect(q('rail-remote-branch')?.textContent).toBe('Branchfeat/x · 1 ahead');
    const changes = [...q('rail-remote-changes')!.querySelectorAll('li')];
    expect(changes.map((li) => li.querySelector('.ck-ftree-name')?.textContent)).toEqual(['src/a.ts', 'docs/new <b>file</b>.md', 'b.ts']);
    expect(changes[0].querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Changed');
    expect(changes[1].querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('New');
    expect(changes[2].textContent).toContain('ready to commit');
    const tree = q('rail-remote-tree')!;
    expect([...tree.querySelectorAll('[role="treeitem"] .ck-ftree-name')].map((n) => n.textContent)).toEqual(['src', 'README.md', HOSTILE, 'shortcut']);
    expect(host.textContent).toContain('2 names are not shown because they hold unusual characters.');
    // Far text is text: no element was made from a name or a path.
    expect(host.querySelector('img')).toBeNull();
    expect(q('rail-remote-changes')!.querySelector('b')).toBeNull();
    // Links are shown, marked, and cannot be opened.
    const link = [...tree.querySelectorAll('[role="treeitem"]')].find((n) => n.textContent?.includes('shortcut'))!;
    expect(link.tagName).toBe('SPAN');
    expect(link.getAttribute('aria-disabled')).toBe('true');
    // The panel offers no write action and none of this PC's sections.
    expect(q('rail-out')).toBeNull();
    for (const b of host.querySelectorAll('button')) expect(b.textContent ?? '').not.toMatch(/commit|stage|save|create|delete|push|merge|pull request/i);
    expect(q('rail-remote-note')?.textContent).toContain('Not available on this computer yet');
    // This PC's own branch is not read for it.
    expect(branchCalls.enabled.every((e) => e === false)).toBe(true);
  });

  it('opens a folder when it is clicked (read then, not before) and a file as a tab of this chat', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    const { api, calls } = fakeApi();
    let tabs: readonly string[] = [];
    function Probe() {
      tabs = usePaneFiles('p1').files;
      return null;
    }
    await act(async () =>
      root.render(
        <>
          <SessionRail {...props} remoteFs={api} />
          <Probe />
        </>,
      ),
    );
    await flush();
    expect([...calls].sort()).toEqual(['list::cached', 'status:cached']);
    const tree = q('rail-remote-tree')!;
    const folder = [...tree.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => b.textContent?.includes('src'))!;
    await act(async () => folder.click());
    await flush();
    expect(calls).toContain('list:src:cached');
    expect(folder.getAttribute('aria-expanded')).toBe('true');
    const file = [...tree.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'a.ts')!;
    await act(async () => file.click());
    expect(tabs).toEqual(['src/a.ts']);
    await act(async () => folder.click());
    expect(folder.getAttribute('aria-expanded')).toBe('false');
  });

  it('reads again when a chat turn ends and on Refresh, and never on a timer', async () => {
    vi.useFakeTimers();
    markRemotePane('p1', 'h1', 'Build box');
    const { api, calls } = fakeApi();
    await mount({ remoteFs: api, status: 'running' });
    expect([...calls].sort()).toEqual(['list::cached', 'status:cached']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(calls.length, 'no polling').toBe(2);
    await mount({ remoteFs: api, status: 'idle' });
    expect(calls.slice(2).sort()).toEqual(['list::fresh', 'status:fresh']);
    await act(async () => q('rail-remote-refresh')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(calls.filter((c) => c === 'status:fresh').length).toBe(2);
  });

  it('says in plain words why a read failed and tries again on request', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    let fail = true;
    const { api } = fakeApi({
      status: vi.fn(async () => {
        if (fail) throw { code: 'SSH_FS_CANNOT_REACH', message: 'English fallback that must not show' };
        return STATUS;
      }),
    });
    await mount({ remoteFs: api });
    expect(q('rail-remote-chg-error')?.textContent).toContain('Cannot reach Build box.');
    expect(q('rail-remote-branch'), 'a failed connection is not "not a git folder"').toBeNull();
    fail = false;
    await act(async () => q('rail-remote-chg-error')!.querySelector('button')!.click());
    await flush();
    expect(q('rail-remote-chg-error')).toBeNull();
    expect(q('rail-remote-changes')).not.toBeNull();
    expect(api.status).toHaveBeenLastCalledWith('p1', true);
  });

  it('says it is not a git folder only when git says so, and says it in the chosen language', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    const { api } = fakeApi({
      status: vi.fn(async () => {
        throw { code: 'SSH_FS_NOT_REPO', message: 'This folder is not a git folder.' };
      }),
    });
    await mount({ remoteFs: api });
    expect(q('rail-remote-branch')?.textContent).toContain('Not a git folder');
    expect(q('rail-remote-chg-error')?.textContent).toContain('This folder is not a git folder.');
    setLanguagePref('zh-TW', false);
    await mount({ remoteFs: api, status: 'idle', agentName: 'Claude 2' });
    expect(q('rail-remote-chg-error')?.textContent).toContain('這個資料夾不是 git 資料夾。');
  });

  it('reads at the end of a turn, not at its start', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    const { api, calls } = fakeApi();
    await mount({ remoteFs: api, status: 'idle' });
    const before = calls.length;
    await mount({ remoteFs: api, status: 'running' });
    expect(calls.length, 'a turn starting reads nothing').toBe(before);
    await mount({ remoteFs: api, status: 'idle' });
    expect(calls.length, 'a turn ending reads again').toBe(before + 2);
  });

  it('never shows one chat\'s files while another chat loads', async () => {
    markRemotePane('p1', 'h1', 'Build box');
    markRemotePane('p2', 'h2', 'Other box');
    const { api } = fakeApi();
    await mount({ remoteFs: api });
    expect(q('rail-remote-tree')?.textContent).toContain('README.md');
    const never = fakeApi({ list: vi.fn(() => new Promise<FarListing>(() => {})), status: vi.fn(() => new Promise<FarStatus>(() => {})) });
    await mount({ paneId: 'p2', remoteFs: never.api });
    expect(q('rail-remote-tree')?.textContent).not.toContain('README.md');
    expect(q('rail-remote-changes')).toBeNull();
  });

  it('a chat on this PC reads nothing over ssh and keeps its own sections', async () => {
    const { api, calls } = fakeApi();
    await mount({ paneId: 'local-1', cwd: '/work/shop', remoteFs: api });
    expect(calls).toEqual([]);
    expect(q('rail-remote-env')).toBeNull();
    expect(q('rail-env')).not.toBeNull();
    expect(branchCalls.enabled.at(-1)).toBe(true);
  });
});
