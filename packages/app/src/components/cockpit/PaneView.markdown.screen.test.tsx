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


const FIXTURE = [
  '<!-- potato-workspace:memory:start -->',
  '<!-- Managed by Potato Workspace from .potato-workspace/memory.md. Edits inside this block are overwritten. -->',
  '- n',
  '<!-- potato-workspace:memory:end -->',
  '',
  'Go on --> and then -> done.',
].join('\n');
// The backend leaves lock files out; this stand-in does the same, so the tree test shows what the screen is given.
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'files_list')
    return {
      truncated: false,
      entries: [
        { path: 'AGENTS.md', name: 'AGENTS.md', isDir: false, size: 300 },
        { path: 'test.docx', name: 'test.docx', isDir: false, size: 30 },
      ],
    };
  if (cmd === 'files_marks') return [];
  if (cmd === 'files_read') return { path: args?.path, name: String(args?.path), size: 300, kind: 'text', text: FIXTURE, dataUrl: null, version: 'v1' };
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'pane_git_branch') return 'main';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../files/CodeEditor', () => ({ CodeEditor: ({ text }: { text: string }) => <pre data-testid="file-code">{text}</pre> }));

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

describe('a Markdown file in the file tab, through the real pane view', () => {
  it('hides HTML comments in the page, keeps arrows as typed, and Show as text still shows the comments', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    const row = [...host.querySelectorAll<HTMLElement>('[data-testid="files-tree"] [role="treeitem"], [data-testid="files-tree"] button')].find((r) => r.textContent?.includes('AGENTS.md'))!;
    await act(async () => row.click());
    await flush();
    await flush();
    const page = host.querySelector('[data-testid="file-markdown"]')!;
    expect(page).toBeTruthy();
    expect([...page.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['n']);
    expect(page.textContent).not.toContain('<!--');
    expect(page.textContent).not.toContain('potato-workspace:memory');
    expect(page.textContent).not.toContain('Managed by');
    // No smart typography: the characters stay as typed.
    expect(page.textContent).toContain('Go on --> and then -> done.');
    expect(page.textContent).not.toContain('→');

    const toggle = [...host.querySelectorAll('button')].find((b) => /show as text/i.test(b.textContent ?? ''))!;
    await act(async () => toggle.click());
    await flush();
    expect(host.querySelector('[data-testid="file-code"]')?.textContent).toContain('<!-- potato-workspace:memory:start -->');
  });

  it('the Files tree shows what the backend lists and no lock file', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    const tree = host.querySelector('[data-testid="files-tree"]')!.textContent ?? '';
    expect(tree).toContain('test.docx');
    expect(tree).not.toContain('~$');
  });
});
