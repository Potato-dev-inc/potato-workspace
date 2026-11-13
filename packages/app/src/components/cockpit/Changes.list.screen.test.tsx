// @vitest-environment jsdom
// Screen-level: the Changes list. A Changes / All files switch, a M / A / D letter, green + and red − counts in mono
// (only the sides that exist), a dim folder and a bright file name. The counts come from the diff data already loaded.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeDiff, WorktreeItem } from '../../lib/cockpit-api';
import { Changes, type ChangesApi } from './Changes';
import { splitPath } from './changes-rows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const ITEM = { handle: 'r', branch: 'pm/r', base: 'main', repo: 'C:/proj', path: 'C:/proj/w', exists: true, state: 'unreviewed', summary: null } as WorktreeItem;
const file = (path: string, status: 'added' | 'modified' | 'deleted', additions: number, deletions: number) => ({ path, status, additions, deletions, binary: false });
const DIFF: WorktreeDiff = {
  branch: 'pm/r',
  base: 'main',
  changes: {
    files: [file('src/login.ts', 'modified', 12, 3), file('src/login.test.ts', 'added', 45, 0), file('src/old-auth.ts', 'deleted', 0, 44)],
    files_changed: 3,
    additions: 57,
    deletions: 47,
    truncated: false,
  },
  patch: '',
  patch_truncated: false,
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const api = { paneWorktree: vi.fn().mockResolvedValue(ITEM), worktreeDiff: vi.fn().mockResolvedValue(DIFF), worktreeMerge: vi.fn(), worktreeDiscard: vi.fn() } as unknown as ChangesApi;
const listFiles = vi.fn().mockResolvedValue([
  { path: 'README.md', absPath: '/p/README.md', name: 'README.md', size: 1 },
  { path: 'src/login.ts', absPath: '/p/src/login.ts', name: 'login.ts', size: 1 },
]);
const mount = async () => {
  await act(async () => root.render(<Changes paneId="p1" status="idle" api={api} listFiles={listFiles} />));
  await act(async () => {});
};

describe('Changes list', () => {
  it('has a Changes / All files switch with the file count on Changes', async () => {
    await mount();
    const tabs = [...host.querySelectorAll('.ck-changes-switch [role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Changes3', 'All files']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('each changed file shows a letter, a dim folder, a bright name and only the counts it has', async () => {
    await mount();
    const rows = [...host.querySelectorAll('.ck-changes-file')];
    expect(rows.map((r) => r.querySelector('.ck-changes-mark')!.textContent)).toEqual(['M', 'A', 'D']);
    expect(rows[0].querySelector('.ck-changes-dir')!.textContent).toBe('src/');
    expect(rows[0].querySelector('.ck-changes-name')!.textContent).toBe('login.ts');
    expect(rows[0].querySelector('.ck-add')!.textContent).toBe('+12');
    expect(rows[0].querySelector('.ck-del')!.textContent).toBe('−3');
    expect(rows[1].querySelector('.ck-del')).toBeNull();
    expect(rows[1].querySelector('.ck-add')!.textContent).toBe('+45');
    expect(rows[2].querySelector('.ck-add')).toBeNull();
    expect(rows[2].querySelector('.ck-del')!.textContent).toBe('−44');
    expect(host.querySelector('.ck-changes-total')!.textContent).toBe('+57 −47');
  });

  it('All files lists the project files, plain, and hides the changed list', async () => {
    await mount();
    const allTab = [...host.querySelectorAll<HTMLElement>('.ck-changes-switch [role="tab"]')][1];
    await act(async () => allTab.click());
    await act(async () => {});
    expect(listFiles).toHaveBeenCalledWith('p1', '', 300);
    const rows = [...host.querySelectorAll('[data-testid="all-files"] li')];
    expect(rows.map((r) => r.textContent)).toEqual(['README.md', 'src/login.ts']);
    expect(host.querySelector('ul.ck-changes-files[hidden]')).not.toBeNull();
  });

  it('splitPath keeps the trailing slash on the folder', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' });
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
  });
});
