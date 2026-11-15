// @vitest-environment jsdom
// "Open in a new window" through the real pane view: a file tab (right-click its tab) and the chat (the More menu).
// The window itself is opened by the backend (mocked here: no window is ever made). The tab leaves the pane while its
// window is open and comes back when the backend says the window closed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView, forgetRememberedTabs, seedRememberedTab } from './PaneView';
import { openFileTab, resetFileTabs } from '../../lib/file-tabs';
import { artifactTabPath } from '../../lib/artifact-tabs';
import { resetFileDrafts, setDraft } from '../../lib/file-drafts';
import { applyTabClosed, resetTabWindows } from '../../lib/tab-windows';
import { useEnglish } from '../../i18n/test-utils';

let openFails = false;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'tab_window_open' && openFails) throw new Error('TAB_WINDOW_NO_PANE: gone');
  if (cmd.startsWith('artifacts_')) throw new Error('ARTIFACT_NOT_HERE: not in this test');
  if (cmd === 'files_list') return { truncated: false, entries: [] };
  if (cmd === 'files_marks') return [];
  if (cmd === 'files_read') return { path: args?.path, name: String(args?.path), size: 5, kind: 'binary', text: null, dataUrl: null };
  if (cmd === 'session_chat_open') return { available: false, reason: 'No chat in this test', items: [] };
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  if (cmd === 'pane_git_branch') return 'main';
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../chat/SessionChatPanel', () => ({ SessionChatPanel: () => <div data-testid="chat-panel" /> }));

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
  resetTabWindows();
  openFails = false;
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
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const fileTab = () => host.querySelector<HTMLButtonElement>('.ck-ftab:not(.ck-ftab--agent) .ck-ftab-main');
const menuItem = () => document.querySelector<HTMLButtonElement>('[data-testid="tab-menu-window"]');
const rightClick = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));

describe('a file tab in its own window', () => {
  it('Open in a new window asks the backend, then the tab leaves the pane until the window closes', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await act(async () => openFileTab('p', 'src/notes.txt'));
    await flush();
    expect(fileTab()?.textContent).toBe('notes.txt');
    await rightClick(fileTab()!);
    expect(menuItem()?.textContent).toBe('Open in a new window');
    await act(async () => menuItem()!.click());
    await flush();
    expect(calls('tab_window_open')[0][1]).toEqual({ paneId: 'p', tab: 'file:src/notes.txt', title: 'notes.txt' });
    expect(fileTab()).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).not.toBeNull();

    // The window closed (Put back, or its close button): the file is a tab again, in front.
    await act(async () => applyTabClosed({ paneId: 'p', tab: 'file:src/notes.txt' }));
    await flush();
    expect(fileTab()?.textContent).toBe('notes.txt');
    expect(fileTab()?.getAttribute('aria-selected')).toBe('true');
  });

  it('a file with unsaved changes cannot be pulled out (the changes would stay behind)', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await act(async () => openFileTab('p', 'a.txt'));
    await flush();
    await act(async () => setDraft('p', 'a.txt', { text: 'x', baseText: 'y', baseVersion: 'v1' }));
    await rightClick(fileTab()!);
    expect(menuItem()?.disabled).toBe(true);
    expect(menuItem()?.title).toBe('Save this file first.');
  });

  it('when the window cannot open, the tab stays and a short notice says so', async () => {
    openFails = true;
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await act(async () => openFileTab('p', 'a.txt'));
    await flush();
    await rightClick(fileTab()!);
    await act(async () => menuItem()!.click());
    await flush();
    expect(fileTab()?.textContent).toBe('a.txt');
    expect(host.querySelector('.ck-ftab-note')?.textContent).toBe('Could not open a new window.');
  });

  it('the pages an agent made have no window menu here (they have their own Open in a window)', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await act(async () => openFileTab('p', artifactTabPath('plan-1')));
    await flush();
    expect(fileTab()).not.toBeNull();
    await rightClick(fileTab()!);
    expect(menuItem()).toBeNull();
  });
});

describe('the chat in its own window', () => {
  async function showChat() {
    seedRememberedTab('p', 'chat');
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" />));
    await flush();
  }
  const openMore = async () => {
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click());
  };
  const moreItem = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Open chat in a new window');

  it('the More menu opens it; the pane then shows a note with Put back, and the chat returns when the window closes', async () => {
    await showChat();
    expect(host.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
    await openMore();
    await act(async () => moreItem()!.click());
    await flush();
    expect(calls('tab_window_open')[0][1]).toEqual({ paneId: 'p', tab: 'chat', title: 'Claude' });
    expect(host.querySelector('[data-testid="chat-panel"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-in-window"]')?.textContent).toContain('This chat is open in its own window.');

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="chat-put-back"]')!.click());
    await flush();
    expect(calls('tab_window_put_back')[0][1]).toEqual({ paneId: 'p', tab: 'chat' });

    await act(async () => applyTabClosed({ paneId: 'p', tab: 'chat' }));
    await flush();
    expect(host.querySelector('[data-testid="chat-in-window"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-panel"]')).not.toBeNull();
  });

  it('while the chat is out, the menu does not offer to open it a second time', async () => {
    await showChat();
    await openMore();
    await act(async () => moreItem()!.click());
    await flush();
    await openMore();
    expect(moreItem()).toBeUndefined();
  });

  it('the agent tab can open the chat too, and a window that fails leaves the chat where it is', async () => {
    openFails = true;
    await showChat();
    await act(async () => openFileTab('p', 'a.txt'));
    await flush();
    await rightClick(host.querySelector('[data-testid="file-tab-agent"] .ck-ftab-main')!);
    expect(menuItem()?.textContent).toBe('Open chat in a new window');
    await act(async () => menuItem()!.click());
    await flush();
    expect(host.querySelector('.ck-ftab-note')?.textContent).toBe('Could not open a new window.');
    expect(host.querySelector('[data-testid="chat-in-window"]')).toBeNull();
  });

  it('a pane view that is itself the window does not offer to pull the chat out again', async () => {
    seedRememberedTab('p', 'chat');
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p" inWindow />));
    await flush();
    await openMore();
    expect(moreItem()).toBeUndefined();
  });
});
