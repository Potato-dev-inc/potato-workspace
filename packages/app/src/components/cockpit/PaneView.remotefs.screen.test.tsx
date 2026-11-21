// @vitest-environment jsdom
// A chat on another computer (SSH), through the real command names: its right panel lists the project's folder, branch and changes,
// a click on a file opens it as a READ-ONLY tab beside the chat, far text is shown as text, an error says why in plain words,
// and not one command that reads or writes this PC's disk for that pane is called.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';
import { openFileTab, resetFileTabs } from '../../lib/file-tabs';
import { resetFileDrafts } from '../../lib/file-drafts';
import { markRemotePane } from '../../lib/remotePanes';
import { useEnglish } from '../../i18n/test-utils';

const answers = vi.hoisted(() => ({ read: null as null | ((path: string) => unknown) }));
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'ssh_git_status') {
    return { branch: 'main', detached: false, unborn: false, ahead: 0, behind: 2, gone: false, more: false, changes: [{ path: 'README.md', kind: 'modified', staged: false }] };
  }
  if (cmd === 'ssh_fs_list') {
    return args?.path === ''
      ? { path: '', more: false, skipped: 0, entries: [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }, { name: 'logo.png', kind: 'file' }] }
      : { path: args?.path, more: false, skipped: 0, entries: [{ name: 'a.ts', kind: 'file' }] };
  }
  if (cmd === 'ssh_fs_read') return answers.read!(String(args?.path));
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../files/CodeEditor', () => ({ CodeEditor: () => <div data-testid="local-editor" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: '\0ssh://h1/srv/app', cols: 80, rows: 24, title: id },
});
function cockpit(): CockpitApi {
  const list = [mk('r1')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['r1', 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'r1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  forgetRememberedTabs();
  resetFileTabs();
  resetFileDrafts();
  invoke.mockClear();
  answers.read = (path) => ({ path, size: 24, text: 'hello <b>world</b>\u001b[31m\n' });
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  markRemotePane('r1', 'h1', 'Build box');
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const mount = async () => {
  await act(async () => root.render(<PaneView c={cockpit()} paneId="r1" />));
  await flush();
};
const commands = () => invoke.mock.calls.map((c) => String(c[0]));

describe('a chat on another computer in the pane view', () => {
  it('lists the folder, the branch and the changes through the ssh commands only', async () => {
    await mount();
    expect(q('rail-remote-branch')?.textContent).toBe('Branchmain · 2 behind');
    expect(q('rail-remote-changes')?.textContent).toContain('README.md');
    expect([...q('rail-remote-tree')!.querySelectorAll('[role="treeitem"] .ck-ftree-name')].map((n) => n.textContent)).toEqual(['src', 'README.md', 'logo.png']);
    expect(invoke).toHaveBeenCalledWith('ssh_fs_list', { paneId: 'r1', path: '', fresh: false });
    expect(invoke).toHaveBeenCalledWith('ssh_git_status', { paneId: 'r1', fresh: false });
    // Nothing reads or writes this PC's disk or git for it.
    const local = commands().filter((c) => /^(files_|pane_git|git_|worktree|turn_|checkpoint)/.test(c));
    expect(local).toEqual([]);
    // The screen never names the machine or the folder: only the pane and a relative path.
    for (const [cmd, args] of invoke.mock.calls) if (String(cmd).startsWith('ssh_')) expect(Object.keys((args ?? {}) as object).sort().every((k) => ['paneId', 'path', 'fresh'].includes(k))).toBe(true);
  });

  it('opens a file as a read-only tab and shows its text as text', async () => {
    await mount();
    const readme = [...q('rail-remote-tree')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'README.md')!;
    await act(async () => readme.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('ssh_fs_read', { paneId: 'r1', path: 'README.md', fresh: false });
    const view = q('remote-file')!;
    expect(view.textContent).toContain('README.md');
    expect(view.textContent).toContain('A read-only copy of this file on Build box.');
    expect(q('remote-file-text')?.textContent).toBe('hello <b>world</b>\u001b[31m\n');
    expect(view.querySelector('b')).toBeNull();
    // No editor, no save: the local editor never mounts and there is no input to type into.
    expect(q('local-editor')).toBeNull();
    expect(view.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
    expect([...view.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Refresh']);
    expect(commands().filter((c) => c.startsWith('files_'))).toEqual([]);
  });

  it('says in plain words when a file cannot be shown', async () => {
    answers.read = () => {
      throw { code: 'SSH_FS_BINARY', message: 'English fallback that must not show' };
    };
    await mount();
    const png = [...q('rail-remote-tree')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'logo.png')!;
    await act(async () => png.click());
    await flush();
    expect(q('remote-file-error')?.textContent).toContain('That file is not plain text, so it is not shown.');
    expect(q('remote-file-text')).toBeNull();
    answers.read = (path) => ({ path, size: 5, text: 'ok\n' });
    await act(async () => q('remote-file-error')!.querySelector('button')!.click());
    await flush();
    expect(q('remote-file-text')?.textContent).toBe('ok\n');
  });
});

describe('a far file whose name looks like one of this app tabs', () => {
  it('is a far file: no local artifact or guide tab is mounted for it', async () => {
    await mount();
    await act(async () => openFileTab('r1', 'artifact:abc'));
    await flush();
    expect(invoke).toHaveBeenCalledWith('ssh_fs_read', { paneId: 'r1', path: 'artifact:abc', fresh: false });
    expect(q('remote-file')?.textContent).toContain('artifact:abc');
    expect(host.querySelector('[data-testid="artifact-tab"]')).toBeNull();
    await act(async () => openFileTab('r1', 'guide:'));
    await flush();
    expect(invoke).toHaveBeenCalledWith('ssh_fs_read', { paneId: 'r1', path: 'guide:', fresh: false });
    expect(q('remote-file')?.textContent).toContain('guide:');
  });
});
