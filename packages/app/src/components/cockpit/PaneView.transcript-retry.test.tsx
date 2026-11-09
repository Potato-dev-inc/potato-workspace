// @vitest-environment jsdom
// The Transcript tab: when the run cannot be read it says so in one plain line, never the raw
// backend text, and "Try again" asks for the run again (the same load the tab does on focus).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView } from './PaneView';

const RAW = 'ACP_PIPE_CLOSED: the transcript pipe closed (os error 32)';
let failFirst = true;
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === 'pane_run_info') {
    if (failFirst) {
      failFirst = false;
      throw new Error(RAW);
    }
    return { handle: 'h1', status: 'completed', receipt: null };
  }
  if (cmd === 'pane_transcript') return { chunks: [{ stream: 'stdout', text: 'hello from the run' }] };
  return null;
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const pane = (id: string, status: string) => ({
  status,
  info: { id, agent_type: 'a', status, pid: 1, created_at: 1, last_output_at: null, cwd: 'C:/proj', cols: 80, rows: 24 },
});

function cockpit(): CockpitApi {
  const list = [pane('p1', 'idle')];
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([['p1', 'Plain']]),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 0,
    selectedId: 'p1',
    spawn: null,
    mode: 'orchestration',
    theme: 'dark',
    launchEntries: [],
    readyAgents: new Set(),
    bridgeLine: '',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  failFirst = true;
  invoke.mockClear();
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
const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === label)!;

/** Opens a view from the More menu (Transcript, Receipt, History). */
const moreTab = (name: string) => {
  act(() => host.querySelector<HTMLButtonElement>('.ck-tabs-bar button[aria-haspopup="menu"]')!.click());
  act(() => [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((t) => t.textContent === name)!.click());
};
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const runInfoCalls = () => invoke.mock.calls.filter((c) => c[0] === 'pane_run_info').length;

describe('the Transcript tab when the run cannot be read', () => {
  it('shows one plain line and Try again, then Try again loads the run and replaces the failure', async () => {
    await act(async () => root.render(<PaneView c={cockpit()} paneId="p1" />));
    await flush();
    moreTab('Transcript');
    await flush();

    // Failing first: the plain line is there, the raw backend text is not.
    expect(host.textContent).toContain('Transcript unavailable');
    expect(host.textContent).toContain("Couldn't load this run's transcript.");
    expect(host.textContent).not.toContain('ACP_PIPE_CLOSED');
    expect(host.textContent).not.toContain('os error 32');
    const retry = button('Try again');
    expect(retry).toBeDefined();

    // Click: the same run load is asked for again, and the failure is gone.
    const before = runInfoCalls();
    await act(async () => retry!.click());
    await flush();
    expect(runInfoCalls()).toBe(before + 1);
    expect(host.textContent).not.toContain('Transcript unavailable');
    expect(host.textContent).toContain('hello from the run');
    expect(button('Try again')).toBeUndefined();
  });
});
