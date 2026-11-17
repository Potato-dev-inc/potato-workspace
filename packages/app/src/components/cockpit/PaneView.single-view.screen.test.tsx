// @vitest-environment jsdom
// Screen-level: the pane header draws its view tabs only when there is a choice to make. A chat session with no
// worktree and no mission has one view (Chat), so no lone "Chat" button is shown. With a worktree, Chat and Changes
// are two views and the tab row comes back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { WorktreeItem } from '../../lib/cockpit-api';
import { PaneView, forgetRememberedTabs } from './PaneView';

let worktreeFor: Record<string, WorktreeItem | null> = {};
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'pane_worktree') return worktreeFor[String(args?.paneId)] ?? null;
  if (cmd === 'checkpoints_list') return { state: 'ok', message: '', items: [] };
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, source: 'acp', items: [] })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
  onSessionChatSource: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const ITEM: WorktreeItem = {
  handle: 'run-1',
  branch: 'pm/run-1',
  base: 'main',
  repo: 'C:/proj',
  path: 'C:/proj/.potato-workspace/worktrees/run-1-ab12',
  exists: true,
  state: 'unreviewed',
  summary: { files_changed: 1, additions: 2, deletions: 0 },
};

function cockpit(lane: 'acp' | undefined): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', status: 'idle', pid: lane ? 0 : 4120, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 100, rows: 30, ...(lane ? { lane } : {}) };
  const p = { status: 'idle', info };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    activities: {},
    previews: {},
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer: vi.fn(),
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetRememberedTabs();
  worktreeFor = {};
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

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const tabNames = () => [...host.querySelectorAll<HTMLElement>('.ck-pane-head [role="tab"]')].map((t) => t.textContent);

describe('pane header view tabs: only when there is a choice', () => {
  it('a chat session with no worktree and no mission has one view, so no tablist and no lone Chat button', async () => {
    await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" />));
    await flush();
    expect(host.querySelector('.ck-pane-head [role="tablist"]')).toBeNull();
    expect(host.querySelector('.ck-pane-head [role="tab"]')).toBeNull();
    // the Chat view itself is still there, and the header keeps its gap span
    expect(host.querySelector('.ck-pane-head .ck-head-gap')).not.toBeNull();
    expect(host.querySelector('textarea')).not.toBeNull();
  });

  it('a chat session with a worktree shows a tablist with Chat and Changes', async () => {
    worktreeFor = { p1: ITEM };
    await act(async () => root.render(<PaneView c={cockpit('acp')} paneId="p1" />));
    await flush();
    const tablist = host.querySelector('.ck-pane-head [role="tablist"]');
    expect(tablist).not.toBeNull();
    expect(tabNames()).toEqual(['Chat', 'Changes1']);
  });
});
