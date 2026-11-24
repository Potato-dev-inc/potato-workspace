// @vitest-environment jsdom
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

const REVIEW = { beforeId: 'c1', afterId: 'c2', files: [{ path: 'src/far.ts', status: 'M', added: 2, removed: 1, binary: false, blob: 'b1' }], truncated: false };
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
    if (cmd === 'checkpoint_file_patch') return '@@ -1 +1 @@\n-a\n+b\n';
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

describe('a far project shows the same files, changes and preview as a local one', () => {
  it('the Files card lists the far PC folder with its marks, and this PC own disk is never asked', async () => {
    await show(farHost());
    expect(filesCard()?.querySelector('[data-path="far.txt"] [data-mark="M"]')).not.toBeNull();
    expect(filesCard()?.querySelector('[data-path="here.txt"]')).toBeNull();
    expect(far.calls).toContainEqual(['files_list', { paneId: 'p', path: '', showHeavy: undefined }]);
    expect(filesCalls()).toEqual([]);
  });

  it('under the key this screen really holds a far chat by, this PC is still never asked', async () => {
    await show(farHost(), 'dev:n1:p');
    expect(filesCard()?.querySelector('[data-path="far.txt"]')).not.toBeNull();
    expect(far.calls).toContainEqual(['files_list', { paneId: 'dev:n1:p', path: '', showHeavy: undefined }]);
    expect(filesCalls()).toEqual([]);
  });

  it('below Full the sections are drawn disabled with the one reason, and nothing is asked of either PC', async () => {
    await show(farHost(WATCH_CAPS));
    expect(host.querySelector('[data-testid="rail-not-here-files"]')?.textContent).toContain('Needs Full on Mac mini.');
    expect(host.querySelector('[data-testid="rail-files"]')).toBeNull();
    expect(far.calls.map(([cmd]) => cmd)).not.toContain('files_list');
    expect(filesCalls()).toEqual([]);
  });

  it('this PC still reads its own folder through the same card', async () => {
    await show();
    expect(filesCard()?.querySelector('[data-path="here.txt"]')).not.toBeNull();
    expect(far.calls).toEqual([]);
  });

  it('a click opens the far file as a tab, read from the far PC', async () => {
    await show(farHost());
    await act(async () => filesCard()!.querySelector<HTMLButtonElement>('[data-path="far.txt"]')!.click());
    await flush();
    expect(host.querySelector('[data-testid="file-tab"]')).not.toBeNull();
    expect(far.calls).toContainEqual(['files_read', { paneId: 'p', path: 'far.txt' }]);
    expect(filesCalls()).toEqual([]);
  });

  it('the branch line and the changes review come from the far PC', async () => {
    await show(farHost());
    expect(host.textContent).toContain('far-branch');
    expect(host.textContent).not.toContain('local-branch');
    expect(far.calls.map(([cmd]) => cmd)).toContain('checkpoint_turn_review');
    expect(filesCalls()).toEqual([]);
  });

  it('a far PC that does not have the file calls draws the sections with the one sentence and asks nothing', async () => {
    await show(farHost(WATCH_CAPS, new Set(['acp_chat_state'])));
    expect(far.calls.map(([cmd]) => cmd)).not.toContain('files_list');
    expect(filesCalls()).toEqual([]);
    expect(host.textContent).toContain('Update Mac mini to use this.');
  });

  it('the preview chip shows the far dev server, and it opens the far window, never a port of this PC', async () => {
    // The key this screen holds a far chat under; the far PC lists its own id (`p`).
    await show(farHost(), 'dev:n1:p');
    const chip = host.querySelector<HTMLButtonElement>('.ck-preview-chip');
    expect(chip?.getAttribute('title')).toContain('localhost:5173');
    await act(async () => chip!.click());
    await flush();
    expect(local.mock.calls).toContainEqual(['far_preview_open', { node: 'n1', pane_id: 'p', port: 5173 }]);
    expect(local.mock.calls.map(([cmd]) => cmd)).not.toContain('point_open_preview');
    expect(local.mock.calls.map(([cmd]) => cmd)).not.toContain('open_external_url');
  });

  it('a file tab opened before still reads from the place the screen shows', async () => {
    await act(async () => openFileTab('p', 'far.txt'));
    await show(farHost());
    expect(far.calls).toContainEqual(['files_read', { paneId: 'p', path: 'far.txt' }]);
  });
});
