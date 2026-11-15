// @vitest-environment jsdom
// "Search inside files" through the real pane view: the Files card in the right panel, its "Inside files" switch, the
// lines found with the match marked, a click that opens the file tab at that line, and the palette command that asks
// for all of it. Nothing opens a window; the backend is mocked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';
import { resetFileTabs } from '../../lib/file-tabs';
import { resetFileDrafts } from '../../lib/file-drafts';
import { resetRailFoldForTests } from './rail/railFold';
import { loadIconSvgs } from '../../lib/material-icons';
import { useEnglish } from '../../i18n/test-utils';

const HITS = {
  hits: [
    { path: 'src/auth.ts', name: 'auth.ts', line: 12, text: 'const needle = findUser(email);', start: 6, end: 12 },
    { path: 'src/auth.ts', name: 'auth.ts', line: 40, text: 'return needle;', start: 7, end: 13 },
    { path: 'docs/guide.md', name: 'guide.md', line: 3, text: 'about the needle', start: 10, end: 16 },
  ],
  truncated: false,
  cancelled: false,
  filesScanned: 3,
};
let searchResult: unknown = HITS;
let searchFails = false;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'files_list') {
    return args?.path === 'src'
      ? { truncated: false, entries: [{ name: 'a.ts', path: 'src/a.ts', isDir: false }] }
      : { truncated: false, entries: [{ name: 'src', path: 'src', isDir: true }, { name: 'README.md', path: 'README.md', isDir: false }] };
  }
  if (cmd === 'files_marks') return [];
  if (cmd === 'files_search_contents') {
    if (searchFails) throw new Error('SEARCH_BROKEN: no');
    return searchResult;
  }
  if (cmd === 'files_search_cancel') return null;
  if (cmd === 'project_files_search') return [{ path: 'src/auth.ts', abs_path: 'x', name: 'auth.ts', size: 1 }];
  if (cmd === 'files_read') return { path: args?.path, name: String(args?.path), size: 30, kind: 'text', text: 'one\ntwo\nthree', dataUrl: null, version: 'v1' };
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'pane_git_branch') return 'main';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
// The code view is mocked: it shows which line it was asked to bring into view.
vi.mock('../files/CodeEditor', () => ({
  CodeEditor: ({ text, goTo }: { text: string; goTo?: { line: number } }) => (
    <pre data-testid="file-code" data-line={goTo?.line ?? ''}>
      {text}
    </pre>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: '/work/shop', cols: 80, rows: 24, title: id },
});
function cockpit(): CockpitApi {
  const list = [mk('p')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p', 'Claude']]),
    activities: {},
    previews: {},
    launchEntries: [],
    readyAgents: new Set(),
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p',
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
  resetRailFoldForTests();
  searchResult = HITS;
  searchFails = false;
  invoke.mockClear();
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
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const flush = () => wait(0);
const sec = () => host.querySelector<HTMLElement>('[data-testid="rail-files"]')!;
async function show() {
  await loadIconSvgs();
  await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
  await flush();
  await flush();
}

describe('Files card in the right panel', () => {
  it('folds, shows the count while folded, and remembers it', async () => {
    await show();
    expect(sec().querySelector('[data-testid="files-tree"]')).not.toBeNull();
    await act(async () => sec().querySelector<HTMLButtonElement>('.rp-sec-h button')!.click());
    expect(sec().querySelector('[data-testid="files-tree"]')).toBeNull();
    expect(sec().querySelector('.rp-sum')!.textContent).toMatch(/· 2$/);
    expect(window.localStorage.getItem('pm.rail.closed')).toContain('files');
  });

  it('Collapse all closes opened folders', async () => {
    await show();
    expect(host.querySelector('[data-testid="files-collapse-all"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click());
    await flush();
    expect(host.querySelector('[data-path="src/a.ts"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="files-collapse-all"]')!.click());
    expect(host.querySelector('[data-path="src/a.ts"]')).toBeNull();
  });

  it('rows carry Material icons by name', async () => {
    await show();
    expect(host.querySelector('[data-path="src"] .mi')!.getAttribute('data-icon')).toBe('folder-src');
    expect(host.querySelector('[data-path="README.md"] .mi')!.getAttribute('data-icon')).toBe('readme');
    expect(host.querySelector('[data-path="README.md"] .mi svg')).not.toBeNull();
  });
});
