// @vitest-environment jsdom
// A helper's own chat shows "Stuck? No progress for N min" with Nudge, Stop and Respawn above the composer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { requestChatTab } from '../../lib/chatTab';
import { setStalls } from '../../lib/stalls';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, items: [] })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string, status: string, title: string, parent?: string) => ({
  status,
  info: { id, agent_type: 'opencode_native', status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title, parent_pane_id: parent },
});

function cockpit(list: ReturnType<typeof mk>[], selected: string): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'OpenCode'])),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: selected,
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  setStalls(new Map());
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
const notice = () => host.querySelector<HTMLElement>('[data-testid="stall-notice"]');

describe('helper chat: stuck', () => {
  it('shows the stuck line and the three buttons only while the helper is stuck, and Nudge reaches the backend', async () => {
    const c = cockpit([mk('lead', 'running', 'Lead'), mk('h1', 'running', 'Sleeper', 'lead')], 'h1');
    requestChatTab('h1');
    await act(async () => root.render(<PaneView c={c} paneId="h1" />));
    await flush();
    expect(notice()).toBeNull();
    await act(async () => setStalls(new Map([['h1', 6]])));
    expect(notice()!.textContent).toContain('Stuck? No progress for 6 min');
    expect([...notice()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Nudge', 'Stop', 'Respawn']);
    await act(async () => [...notice()!.querySelectorAll('button')].find((b) => b.textContent === 'Nudge')!.click());
    expect(invoke).toHaveBeenCalledWith('stall_nudge', { paneId: 'h1' });
    await act(async () => setStalls(new Map()));
    expect(notice()).toBeNull();
  });
});
