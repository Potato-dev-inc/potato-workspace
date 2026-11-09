// @vitest-environment jsdom
// The pane's top bar has a "Hand off" button that runs the same starter as the sidebar's "Handoff from here" row item.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { LiveStatus } from '../../lib/live-room';
import { PaneView } from './PaneView';
import type { HandoffControl } from '../../hooks/useHandoff';

const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null) as unknown);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

function cockpit(): CockpitApi {
  const p = { status: 'idle', info: { id: 'p1', agent_type: 'claude', status: 'idle', pid: 1, created_at: 1, last_output_at: null, cwd: 'C:\work\shop', cols: 80, rows: 24 } };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

function control(over: Partial<HandoffControl> = {}): HandoffControl {
  return { status: null, busy: false, allowed: () => true, start: vi.fn(), dismiss: vi.fn(), ...over };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockImplementation(async (cmd: string) => (cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null));
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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const btn = () => host.querySelector<HTMLButtonElement>('[data-testid="pane-handoff"]');
const show = async (handoff?: HandoffControl) => {
  await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" handoff={handoff} />));
  await flush();
};

describe('pane header: Hand off', () => {
  it('starts the handoff for this pane', async () => {
    const h = control();
    await show(h);
    expect(btn()!.textContent).toBe('Hand off');
    act(() => btn()!.click());
    expect(h.start).toHaveBeenCalledWith('p1');
  });

  it('is disabled and says so while one runs', async () => {
    await show(control({ busy: true }));
    expect(btn()!.disabled).toBe(true);
    expect(btn()!.textContent).toBe('Handing off…');
  });

  it('is hidden for a plain shell, and without a starter', async () => {
    await show(control({ allowed: () => false }));
    expect(btn()).toBeNull();
    await show(undefined);
    expect(btn()).toBeNull();
  });
});
