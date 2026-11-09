// @vitest-environment jsdom
// "Handoff from here": the pane row menu has the item, the item starts the flow, the status line shows each step and
// the plain-English failure, and a plain shell has no such item.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';
import { HANDOFF_WRITE_PROMPT, type HandoffDeps } from '../../lib/handoff';
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
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function fakeApi(): CockpitApi {
  const mk = (id: string, agent: string) => {
    const info = { id, agent_type: agent, pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo;
    return { info, status: 'idle' };
  };
  const panes = [mk('p1', 'agentx'), mk('p2', 'plainshell')];
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map([
      ['p1', 'Agent X'],
      ['p2', 'Shell'],
    ]),
    asked: { questions: [] },
    launchEntries: [
      { type: 'agentx', label: 'Agent X', icon: null },
      { type: 'plainshell', label: 'Shell', icon: null, shell: true },
    ],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: 'p1',
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    prompts: {},
    statusSince: new Map([
      ['p1', 0],
      ['p2', 0],
    ]),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const makeShip = (): ShipApi =>
  ({
    recent: vi.fn(async () => []),
    gitState: vi.fn(async () => 'repo' as unknown as GitState),
    gitInitPlan: vi.fn(),
    gitInit: vi.fn(),
    forget: vi.fn(),
    pickFolder: vi.fn(),
  }) as unknown as ShipApi;

/** Deps for a terminal pane whose agent finishes its turn after two polls and writes the file (or not). */
function fakeDeps(writes: boolean): HandoffDeps {
  let sent = false;
  let busy = 2;
  let clock = 0;
  const stats = writes ? [{ exists: false, modifiedMs: 0, bytes: 0 }, { exists: true, modifiedMs: 1, bytes: 10 }] : [{ exists: false, modifiedMs: 0, bytes: 0 }];
  return {
    pane: () => ({ id: 'p1', agentType: 'agentx', cwd: 'C:\\work\\shop', status: sent && busy > 0 ? 'running' : 'idle' }),
    chatState: async () => null,
    send: vi.fn(async (id: string) => {
      if (id === 'p1') sent = true;
    }),
    stat: async () => stats.shift() ?? stats[0] ?? { exists: false, modifiedMs: 0, bytes: 0 },
    startTerminal: vi.fn(async () => 'n1'),
    startChat: vi.fn(async () => 'n1'),
    startTerminalChat: vi.fn(async () => 'n1'),
    setConfig: vi.fn(async () => undefined),
    select: vi.fn(),
    titleOf: () => 'Agent X two',
    sleep: async (ms: number) => {
      clock += ms;
      if (sent && busy > 0) busy -= 1;
    },
    now: () => clock,
  };
}

async function render(c: CockpitApi, handoffDeps: HandoffDeps) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={makeShip()} handoffDeps={handoffDeps} />));
  await act(async () => {});
}

const rowOf = (name: string): HTMLButtonElement => {
  const row = [...host.querySelectorAll<HTMLButtonElement>('button.ck-row')].find((b) => b.querySelector('.ck-row-title')?.textContent === name);
  if (!row) throw new Error(`no row named ${name}`);
  return row;
};
const rightClick = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
const menuItem = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === label);
const statusText = () => host.querySelector('[data-testid="handoff-status"]')?.textContent ?? null;

describe('Handoff from here (pane row menu)', () => {
  it('shows the item on an agent pane, not on a plain shell', async () => {
    await render(fakeApi(), fakeDeps(true));
    await act(async () => rightClick(rowOf('Agent X')));
    expect(menuItem('Handoff from here')).toBeTruthy();
    await act(async () => rightClick(rowOf('Shell')));
    expect(menuItem('Handoff from here')).toBeUndefined();
  });

  it('starts the flow: asks the agent for HANDOFF.md, then reports the new pane', async () => {
    const deps = fakeDeps(true);
    await render(fakeApi(), deps);
    await act(async () => rightClick(rowOf('Agent X')));
    await act(async () => menuItem('Handoff from here')!.click());
    await vi.waitFor(() => expect(statusText()).toContain('Opened Agent X two'));
    expect(deps.send).toHaveBeenCalledWith('p1', HANDOFF_WRITE_PROMPT);
    expect(deps.startTerminal).toHaveBeenCalledWith('agentx', 'C:\\work\\shop');
    // The old pane stays open: nothing closes or replaces it.
    expect(rowOf('Agent X')).toBeTruthy();
  });

  it('says in plain words when the file was not written, and can be dismissed', async () => {
    await render(fakeApi(), fakeDeps(false));
    await act(async () => rightClick(rowOf('Agent X')));
    await act(async () => menuItem('Handoff from here')!.click());
    await vi.waitFor(() => expect(statusText()).toContain("The agent finished but HANDOFF.md wasn't written."));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="handoff-status"] button')!.click());
    expect(statusText()).toBeNull();
  });
});
