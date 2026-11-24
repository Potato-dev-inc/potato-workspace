// @vitest-environment jsdom
// The New agent page owns the sidebar highlight: the chat that was open before it stays unlit.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function api(): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\work\proj', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
  const panes = [{ info, status: 'idle' }];
  return {
    registry: { paneList: panes, panes: new Map([['p1', panes[0]]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select: vi.fn(),
    prompts: {},
    statusSince: new Map([['p1', 0]]),
    now: 60_000,
    spawn: null,
    dismissSpawn: vi.fn(),
    toasts: [],
    notify: vi.fn(),
    setMode: vi.fn(async () => {}),
    toggleTheme: vi.fn(async () => {}),
    newAgent: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    bridgeLine: 'Bridge test',
  } as unknown as CockpitApi;
}

describe('sidebar highlight', () => {
  it('lights the open chat only while no page is open on top of it', async () => {
    await act(async () => root.render(<Sidebar c={api()} onOpenPalette={() => undefined} />));
    const lit = () => host.querySelectorAll('.ck-row.is-active[data-pane-id], .ck-rowwrap .ck-row.is-active').length;
    const before = lit();
    expect(before).toBeGreaterThan(0);
    await act(async () => root.render(<Sidebar c={api()} onOpenPalette={() => undefined} newAgentOpen />));
    expect(lit()).toBe(0);
  });
});
