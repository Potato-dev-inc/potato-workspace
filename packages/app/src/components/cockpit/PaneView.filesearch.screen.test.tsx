// @vitest-environment jsdom
// "Search inside files" through the real pane view: the Files card in the right panel, its "Inside files" switch, the
// lines found with the match marked, a click that opens the file tab at that line, and the palette command that asks
// for all of it. Nothing opens a window; the backend is mocked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';
import { Palette } from './Palette';
import { resetFileTabs } from '../../lib/file-tabs';
import { resetFileDrafts } from '../../lib/file-drafts';
import { resetContentSearchRequest } from '../../lib/files-search-request';
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
  if (cmd === 'files_list') return { truncated: false, entries: [] };
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
  resetContentSearchRequest();
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

function typeInto(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  return act(async () => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const filter = () => host.querySelector<HTMLInputElement>('[data-testid="files-filter"]')!;
const searchCalls = () => invoke.mock.calls.filter((c) => c[0] === 'files_search_contents');

async function openInsideMode() {
  await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
  await flush();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="files-mode-inside"]')!.click());
}

describe('search inside files, in the right panel', () => {
  it('finds lines, groups them by file, marks the words, and a click opens the file at that line', async () => {
    await openInsideMode();
    expect(filter().placeholder).toBe('Search inside files');
    await typeInto(filter(), 'needle');
    await wait(450);
    expect(invoke).toHaveBeenCalledWith('files_search_contents', { paneId: 'p', query: 'needle', searchId: 'files-p' });
    const list = host.querySelector('[data-testid="files-content-hits"]')!;
    expect(list.querySelectorAll('[data-testid="files-content-hit"]')).toHaveLength(3);
    expect(list.querySelectorAll('.ck-fsearch-file')).toHaveLength(2); // two files
    expect([...list.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['needle', 'needle', 'needle']);
    expect(list.querySelector('[data-testid="files-content-hit"]')?.getAttribute('aria-label')).toBe('auth.ts, line 12: const needle = findUser(email);');

    await act(async () => list.querySelectorAll<HTMLButtonElement>('[data-testid="files-content-hit"]')[1].click());
    await flush();
    await flush();
    expect(host.querySelector('.ck-ftab:not(.ck-ftab--agent) [role="tab"]')?.textContent).toBe('auth.ts');
    expect(invoke).toHaveBeenCalledWith('files_read', { paneId: 'p', path: 'src/auth.ts' });
    expect(host.querySelector('[data-testid="file-code"]')?.getAttribute('data-line')).toBe('40');
  });

  it('a second hit of the same file moves the open tab to the new line, without a second tab', async () => {
    await openInsideMode();
    await typeInto(filter(), 'needle');
    await wait(450);
    const hits = () => host.querySelectorAll<HTMLButtonElement>('[data-testid="files-content-hit"]');
    await act(async () => hits()[0].click());
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="file-code"]')?.getAttribute('data-line')).toBe('12');
    await act(async () => hits()[1].click());
    await flush();
    expect(host.querySelector('[data-testid="file-code"]')?.getAttribute('data-line')).toBe('40');
    expect(host.querySelectorAll('.ck-ftab:not(.ck-ftab--agent)')).toHaveLength(1);
  });

  it('waits for two characters, says when nothing matches, and says when the list was cut', async () => {
    await openInsideMode();
    await typeInto(filter(), 'n');
    await wait(450);
    expect(searchCalls()).toHaveLength(0);
    searchResult = { hits: [], truncated: false, cancelled: false, filesScanned: 4 };
    await typeInto(filter(), 'zzzz');
    await wait(450);
    expect(host.textContent).toContain('No file has those words.');
    searchResult = { ...HITS, truncated: true };
    await typeInto(filter(), 'needle');
    await wait(450);
    expect(host.textContent).toContain('Showing the first 3 lines.');
  });

  it('a failed search says so in plain words', async () => {
    searchFails = true;
    await openInsideMode();
    await typeInto(filter(), 'needle');
    await wait(450);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The search did not work. Try again.');
  });

  it('the file names box is not changed: names mode never calls the contents search', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    expect(host.querySelector('[data-testid="files-mode-names"]')?.getAttribute('aria-pressed')).toBe('true');
    await typeInto(filter(), 'auth');
    await wait(450);
    expect(searchCalls()).toHaveLength(0);
    expect(invoke.mock.calls.some((c) => c[0] === 'project_files_search')).toBe(true);
  });

  it('a newer word asks the backend to stop the older search', async () => {
    await openInsideMode();
    await typeInto(filter(), 'need');
    await wait(450);
    await typeInto(filter(), 'needle');
    await wait(450);
    expect(invoke.mock.calls.filter((c) => c[0] === 'files_search_cancel' && (c[1] as { searchId: string }).searchId === 'files-p').length).toBeGreaterThan(0);
  });
});

describe('the palette command Search in files', () => {
  it('is listed for the open agent and puts the right panel on the inside-files box', async () => {
    const c = cockpit();
    // The palette and the pane share the window, as in the app.
    await act(async () =>
      root.render(
        <>
          <Palette c={c} onClose={vi.fn()} />
          <PaneView c={c} paneId="p" />
        </>,
      ),
    );
    await flush();
    const row = [...host.querySelectorAll('[role="option"]')].find((r) => r.textContent?.includes('Search in files'));
    expect(row).toBeTruthy();
    await act(async () => (row as HTMLElement).click());
    await flush();
    await flush();
    expect(host.querySelector('[data-testid="files-mode-inside"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(filter().placeholder).toBe('Search inside files');
  });

  it('opens a hidden right panel and unfolds a folded Files section', async () => {
    window.localStorage.setItem('pm.sessionRail.open', '0');
    window.localStorage.setItem('pm.rail.closed', 'files');
    const c = cockpit();
    await act(async () =>
      root.render(
        <>
          <Palette c={c} onClose={vi.fn()} />
          <PaneView c={c} paneId="p" />
        </>,
      ),
    );
    await flush();
    expect(host.querySelector('[data-testid="rail-files"]')).toBeNull();
    const row = [...host.querySelectorAll('[role="option"]')].find((r) => r.textContent?.includes('Search in files'));
    await act(async () => (row as HTMLElement).click());
    await flush();
    await flush();
    await wait(10);
    expect(host.querySelector('[data-testid="rail-files"]')).not.toBeNull();
    expect(filter()).not.toBeNull();
    expect(host.querySelector('[data-testid="files-mode-inside"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});
