// @vitest-environment jsdom
// A far chat's finished turn: the right panel's Changes, the Review (Receipt tab) and the file view tell one story. The far PC has checkpoints for the
// turn but this PC holds no turn summary or run receipt for a far chat, and git there has no diff for the added file.
// Screen-level (P5): a project on another PC shows the same Files card, the same Changes review, the same file tab and the same preview chip as a
// local one. The real PaneView renders the same pane twice, once on this PC and once inside a HostProvider that holds a fake far host. The far host
// answers the file, review and preview calls itself; this PC's own invoke never hears a files call for the far chat.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { HostProvider } from '../../lib/host/context';
import { ALL_CAPS, WATCH_CAPS, type Host } from '../../lib/host/host';
import { resetFileTabs, openFileTab } from '../../lib/file-tabs';
import { resetFileDrafts } from '../../lib/file-drafts';
import { useEnglish } from '../../i18n/test-utils';
import { PaneView, forgetRememberedTabs } from './PaneView';

const local = vi.fn(async (cmd: string) => {
  if (cmd === 'files_list') return { truncated: false, entries: [{ name: 'here.txt', path: 'here.txt', isDir: false, size: 1 }] };
  if (cmd === 'files_marks') return [];
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'checkpoint_turn_review') return null;
  if (cmd === 'pane_git_branch') return 'local-branch';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (local as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../files/CodeEditor', () => ({ CodeEditor: ({ text }: { text: string }) => <pre data-testid="file-code">{text}</pre> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const REVIEW = { turn: 1, beforeId: 'c1', afterId: 'c2', files: [{ path: 'perm-test.txt', status: 'A', added: 1, deleted: 0, binary: false, blob: 'b1' }], truncated: false };
const far = { calls: [] as Array<[string, Record<string, unknown> | undefined]> };
const farHost = (caps = ALL_CAPS, calls?: ReadonlySet<string>): Host => ({
  place: { kind: 'pc', node: 'n1', name: 'Mac mini' },
  live: true,
  caps,
  can: calls ? (cmd) => calls.has(cmd) : undefined,
  notYet: 'Update Mac mini to use this.',
  denied: (cap) => (caps[cap] ? null : 'Needs Full on Mac mini.'),
  invoke: (async (cmd: string, args?: Record<string, unknown>) => {
    far.calls.push([cmd, args]);
    if (cmd === 'files_list') return { truncated: false, entries: [{ name: 'far.txt', path: 'far.txt', isDir: false, size: 5 }] };
    if (cmd === 'files_marks') return [{ path: 'far.txt', mark: 'M' }];
    if (cmd === 'files_read') return { path: args?.path, name: String(args?.path), size: 5, kind: 'text', text: 'far text', dataUrl: null, version: 'v1' };
    if (cmd === 'checkpoint_turn_review') return REVIEW;
    if (cmd === 'checkpoint_file_patch') return 'diff --git a/perm-test.txt b/perm-test.txt\n--- /dev/null\n+++ b/perm-test.txt\n@@ -0,0 +1 @@\n+hello\n';
    // The far folder is not a git repo: git has no diff for the file the turn added.
    if (cmd === 'files_diff') return '';
    if (cmd === 'pane_git_branch') return 'far-branch';
    if (cmd === 'pane_previews') return { p: [{ url: 'http://localhost:5173/', port: 5173 }] };
    if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
    if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
    return null;
  }) as Host['invoke'],
  listen: (async () => () => undefined) as Host['listen'],
});

const mk = (id: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: '/work/shop', cols: 80, rows: 24, title: id },
});
function cockpit(id = 'p'): CockpitApi {
  const list = [mk(id)];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([[id, 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: id,
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
  far.calls = [];
  local.mockClear();
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true });
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
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
    await new Promise((r) => setTimeout(r, 20));
  });
async function show(on?: Host, id = 'p') {
  await act(async () => root.render(on ? <HostProvider host={on}><PaneView c={cockpit(id)} paneId={id} /></HostProvider> : <PaneView c={cockpit(id)} paneId={id} />));
  await flush();
  await flush();
}
const filesCard = () => host.querySelector('[data-testid="rail-files"]');
const filesCalls = () => local.mock.calls.filter(([cmd]) => /^(files_|checkpoint|pane_git_branch|pane_previews|pane_usage|artifacts_|project_files_search)/.test(cmd as string));


describe('a far chat after a finished turn: Changes, Review and the file view agree', () => {
  it('Review opens the files of the turn, not "No turns yet", and the changed file opens with its diff', async () => {
    await show(farHost(), 'dev:n1:p');
    expect(host.textContent).toContain('perm-test.txt');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Review');
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    await flush();
    const body = host.querySelector('.ck-pane-body')!.textContent!;
    expect(body).not.toContain('No turns yet');
    expect(body).toContain('perm-test.txt');
  });

  const openReview = async () => {
    await show(farHost(), 'dev:n1:p');
    const review = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Review');
    await act(async () => review!.click());
    await flush();
    expect(host.querySelector('.ck-pane-body .ck-receipt')).not.toBeNull();
  };
  it('after Review the More menu offers Chat, and picking it leaves the review', async () => {
    await openReview();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Chat');
    expect(item).toBeTruthy();
    await act(async () => item!.click());
    await flush();
    // Back on the chat (the fake host has no chat feed, so no message box is drawn here).
    expect(host.querySelector('.ck-pane-body .ck-receipt')).toBeNull();
  });

  it('Escape leaves the review and returns to the chat', async () => {
    await openReview();
    const body = host.querySelector<HTMLElement>('.ck-pane-body')!;
    await act(async () => {
      body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await flush();
    expect(host.querySelector('.ck-pane-body .ck-receipt')).toBeNull();
  });

  it('the Review of a far chat does not offer Open in my editor (the file is on the other PC)', async () => {
    await show(farHost(), 'dev:n1:p');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Review');
    await act(async () => button!.click());
    await flush();
    const body = host.querySelector('.ck-pane-body')!;
    expect(body.textContent).toContain('perm-test.txt');
    expect([...body.querySelectorAll('button')].some((b) => /^Open in/.test(b.textContent ?? ''))).toBe(false);
  });

  it('the Review of a far chat sits in the padded receipt column, so "0 of 1 looked at" is not flush with the panel edge', async () => {
    await show(farHost(), 'dev:n1:p');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Review');
    await act(async () => button!.click());
    await flush();
    expect(host.querySelector('.ck-pane-body .ck-receipt [data-testid="turn-files-looked"]')).not.toBeNull();
  });

  it('the file view shows the patch of the turn when git has none', async () => {
    await act(async () => openFileTab('dev:n1:p', 'perm-test.txt'));
    await show(farHost(), 'dev:n1:p');
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Changes' && b.closest('[data-testid="file-tab"]'));
    expect(toggle).toBeTruthy();
    await act(async () => toggle!.click());
    await flush();
    const text = host.querySelector('[data-testid="file-tab"]')!.textContent!;
    expect(text).not.toContain('has not changed');
    expect(text).toContain('hello');
  });
});

describe('the file view when git cannot answer', () => {
  const open = async (path: string, diff: () => Promise<string>) => {
    const h = farHost();
    const inner = h.invoke;
    h.invoke = (async (cmd: string, args?: Record<string, unknown>) => (cmd === 'files_diff' ? diff() : inner(cmd, args))) as Host['invoke'];
    await act(async () => openFileTab('dev:n1:p', path));
    await show(h, 'dev:n1:p');
    const toggle = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Changes' && b.closest('[data-testid="file-tab"]'));
    await act(async () => toggle!.click());
    await flush();
    return host.querySelector('[data-testid="file-tab"]')!.textContent!;
  };
  it('a git error still shows the turn patch', async () => {
    const text = await open('perm-test.txt', () => Promise.reject(new Error('FILES_IO: not a git folder')));
    expect(text).not.toContain('has not changed');
    expect(text).toContain('hello');
  });
  it('a file opened by its full path finds its turn patch', async () => {
    const text = await open('/work/shop/perm-test.txt', async () => '');
    expect(text).toContain('hello');
  });
});

describe('Open in my editor', () => {
  const headButtons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="file-tab"] .ck-file-head button')].map((b) => b.textContent ?? '');
  it('is offered for a file of this PC', async () => {
    await act(async () => openFileTab('p', 'here.txt'));
    await show(undefined, 'p');
    expect(headButtons().some((b) => /^Open in/.test(b))).toBe(true);
  });
  it('is not offered for a file on another PC, where it cannot open', async () => {
    await act(async () => openFileTab('dev:n1:p', 'far.txt'));
    await show(farHost(), 'dev:n1:p');
    expect(host.querySelector('[data-testid="file-tab"]')).not.toBeNull();
    expect(headButtons().some((b) => /^Open in/.test(b))).toBe(false);
  });
});
