// @vitest-environment jsdom
// Files in the pane view: the Files card sits in the right panel, a click opens the file as a tab beside the chat,
// closing the tab goes back to where the pane was, and a pane's tabs never leak into another pane.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs } from './PaneView';
import { resetFileTabs, openFileTab } from '../../lib/file-tabs';
import { useEnglish } from '../../i18n/test-utils';

const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'files_list') {
    return args?.path === ''
      ? { truncated: false, entries: [{ name: 'src', path: 'src', isDir: true, size: 0 }, { name: 'notes.txt', path: 'notes.txt', isDir: false, size: 5 }] }
      : { truncated: false, entries: [] };
  }
  if (cmd === 'files_marks') return [{ path: 'notes.txt', mark: 'M' }];
  if (cmd === 'files_read') return { path: args?.path, name: String(args?.path), size: 5, kind: 'binary', text: null, dataUrl: null };
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
    await new Promise((r) => setTimeout(r, 0));
  });

describe('files in the pane view', () => {
  it('shows the Files card in the right panel and opens a clicked file as a tab', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    const card = host.querySelector('[data-testid="rail-files"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('[data-path="notes.txt"] [data-mark="M"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="file-tabs"]')).toBeNull();

    await act(async () => card!.querySelector<HTMLButtonElement>('[data-path="notes.txt"]')!.click());
    await flush();
    const tabs = host.querySelector('[data-testid="file-tabs"]')!;
    expect(tabs.querySelector('[role="tab"]')?.textContent).toBe('notes.txt');
    expect(tabs.querySelector('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="file-tab"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('files_read', { paneId: 'p', path: 'notes.txt' });
  });

  it('closing the file tab goes back to the terminal', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    await act(async () => openFileTab('p', 'notes.txt'));
    await flush();
    expect(host.querySelector('[data-testid="file-tab"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-ftab-x')!.click());
    await flush();
    expect(host.querySelector('[data-testid="file-tab"]')).toBeNull();
    expect(host.querySelector('[data-testid="file-tabs"]')).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).not.toBeNull();
  });

  it('the main tabs still bring the pane back from a file', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
    await act(async () => openFileTab('p', 'notes.txt'));
    await flush();
    const terminal = [...host.querySelectorAll<HTMLButtonElement>('.ck-seg [role="tab"]')].find((b) => b.textContent === 'Terminal')!;
    await act(async () => terminal.click());
    await flush();
    expect(host.querySelector('[data-testid="term"]')).not.toBeNull();
    // The file stays open as a tab, just not in front.
    expect(host.querySelector('[data-testid="file-tabs"] [role="tab"]')?.getAttribute('aria-selected')).toBe('false');
  });
});
