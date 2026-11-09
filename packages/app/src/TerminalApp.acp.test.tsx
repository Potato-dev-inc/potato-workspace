// @vitest-environment jsdom
// The pop-out window of a pane (?terminal=1&detached=1&pane=...): a chat session over ACP (a helper's default place)
// has no terminal, so its window is the chat pane, never a terminal viewport or "No terminal pane selected."
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from './hooks/useCockpit';
import { forgetRememberedTabs } from './components/cockpit/PaneView';

const state = vi.hoisted(() => ({ lane: 'acp' as 'acp' | undefined }));
const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('./components/TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('./components/ClosePaneConfirm', () => ({ ClosePaneConfirm: () => null }));
vi.mock('./hooks/useBridge', () => ({ useBridge: () => ({ client: null, isReady: true, error: null }) }));
vi.mock('./hooks/useProjectPath', () => ({ useProjectPath: () => ({ projectPath: null }) }));
vi.mock('./lib/agentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/agentRegistry')>()),
  useAgentRegistry: () => ({ agents: [{ id: 'codex', kind: 'agent' }] }),
  launchMenuEntries: () => [],
}));
vi.mock('./lib/tauri', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/tauri')>();
  return {
    ...mod,
    tauri: {
      ...mod.tauri,
      onPaneDetach: async () => () => undefined,
      onCurrentWindowCloseRequested: async () => () => undefined,
      resizeCurrentWindow: async () => undefined,
      closeCurrentWindow: async () => undefined,
    },
  };
});
vi.mock('./lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, source: 'acp', items: [{ kind: 'user', id: 'u1', at: null, text: 'Write notes.txt' }] })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
  onSessionChatSource: vi.fn(async () => () => undefined),
}));
vi.mock('./hooks/usePaneRegistry', () => ({
  usePaneRegistry: () => {
    const info = { id: 'p1', agent_type: 'codex', status: 'idle', pid: state.lane ? 0 : 4120, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 100, rows: 30, ...(state.lane ? { lane: state.lane } : {}) };
    const p = { status: 'idle', info };
    return { paneList: [p], panes: new Map([['p1', p]]), initialReady: true, spawnPane: vi.fn(), killPane: vi.fn(), writeInput: vi.fn() };
  },
}));
vi.mock('./hooks/useCockpit', () => ({
  useCockpit: () => {
    const info = { id: 'p1', agent_type: 'codex', status: 'idle', pid: 0, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 100, rows: 30, lane: 'acp' };
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
      theme: 'dark',
      selectedId: 'p1',
      mode: 'individual',
      select: vi.fn(),
      notify: vi.fn(),
      answer: vi.fn(),
      closePane: vi.fn(),
    } as unknown as CockpitApi;
  },
}));

import TerminalApp from './TerminalApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetRememberedTabs();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  window.history.replaceState(null, '', '/?terminal=1&detached=1&pane=p1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 150)); });

describe('pane window of a chat session over ACP', () => {
  it('is the chat pane: header badge, conversation and message box; no terminal, no "no terminal" text', async () => {
    state.lane = 'acp';
    await act(async () => root.render(<TerminalApp />));
    await flush();
    expect(host.querySelector('[data-testid="acp-pane-window"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pane-lane"]')?.textContent).toBe('Chat (ACP)');
    expect(host.textContent).toContain('Write notes.txt');
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('[data-testid="term"]')).toBeNull();
    expect(host.textContent).not.toMatch(/no terminal|not available/i);
  });

  it('a terminal pane keeps its terminal viewport', async () => {
    state.lane = undefined;
    await act(async () => root.render(<TerminalApp />));
    await flush();
    expect(host.querySelector('[data-testid="acp-pane-window"]')).toBeNull();
    expect(host.querySelector('[data-testid="term"]')).not.toBeNull();
  });
});
