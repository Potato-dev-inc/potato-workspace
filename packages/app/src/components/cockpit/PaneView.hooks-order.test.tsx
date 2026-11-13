// @vitest-environment jsdom
// A popped-out pane window can mount before its pane reaches the registry. The first render shows the "opening" screen,
// the next renders the pane. Every hook must run on both renders, or React throws #310 ("Rendered more hooks than during
// the previous render") and the window goes blank.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { resetNotifyStoreForTest } from '../../lib/notify-store';
import { PaneView } from './PaneView';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const mk = (id: string, title: string) => ({
  status: 'idle',
  info: { id, agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24, title },
});

function cockpit(list: ReturnType<typeof mk>[], selected: string): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, 'Claude'])),
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
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  resetNotifyStoreForTest();
  invoke.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

describe('PaneView hook order (popped-out pane window)', () => {
  it('a pane that is not in the registry yet opens, then renders once it arrives, without a hook-order crash', async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
    window.addEventListener('error', onError);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // First render: the pane is not known yet, so PaneView shows the "opening" screen.
      const early = cockpit([], 'p');
      await act(async () => root.render(<PaneView c={early} paneId="p" />));
      await flush();
      expect(host.querySelector('.ck-spawn')).not.toBeNull();

      // Next render: the pane has arrived. This must not throw (React #310 before the fix).
      const later = cockpit([mk('p', 'Refactor auth')], 'p');
      await act(async () => root.render(<PaneView c={later} paneId="p" />));
      await flush();
      expect(host.querySelector('.ck-spawn')).toBeNull();
      expect(host.querySelector('[aria-label="More"]')).not.toBeNull();

      const reported = [...errors, ...spy.mock.calls.flat()].map(String).join('\n');
      expect(reported).not.toMatch(/#310|Rendered more hooks/);
    } finally {
      window.removeEventListener('error', onError);
      spy.mockRestore();
    }
  });
});
