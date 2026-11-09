// @vitest-environment jsdom
// The "New agent" menu with hidden agents, as a whole screen: the real Sidebar and the real menu. Only the desktop
// shell (`invoke`) is mocked. Covers: a hidden agent is gone from the menu; "Edit list…" opens the editor, a tick
// shows or hides an agent and Back returns to the menu; the last shown agent cannot be hidden; "Show all" brings
// everything back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { LS_HIDDEN_AGENTS } from '../../lib/hiddenAgents';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

// Labs chat is off: the menu has no Chat | Terminal switch and every row starts a terminal.
function answer(command: string): unknown {
  switch (command) {
    case 'agent_lane_get':
      return { labs_enabled: false, agents: [], can_add_chat: [], terminal_chat: [] };
    case 'acp_addon_status':
      return { labs_enabled: false, addons: [] };
    default:
      return null;
  }
}

const ENTRIES = [
  { type: 'readyagent', label: 'Ready agent' },
  { type: 'addonagent', label: 'Addon agent' },
  { type: 'nochat', label: 'No chat agent' },
  { type: 'powershell', label: 'PowerShell', shell: true },
];

function cockpit() {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: ENTRIES,
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    newAgent: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi & { newAgent: ReturnType<typeof vi.fn> };
}

const ship = {
  recent: vi.fn().mockResolvedValue([]),
  gitState: vi.fn().mockResolvedValue('repo'),
} as unknown as ShipApi;

const startModeApi = { get: async () => 'chat' as const, set: async () => {} };

let host: HTMLDivElement;
let root: Root;
let c: ReturnType<typeof cockpit>;

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => answer(command));
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  c = cockpit();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => {});
};
async function mount() {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} startModeApi={startModeApi} />));
  await settle();
}
async function openMenu() {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New agent"]')!.click());
  await settle();
  return host.querySelector<HTMLElement>('[role="menu"]')!;
}
const menu = () => host.querySelector<HTMLElement>('[role="menu"]')!;
const menuRowLabels = () => [...menu().querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].map((b) => b.querySelector('span')?.textContent);
const editBox = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Show ${label} in the New agent menu"]`);
const buttonNamed = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const click = async (el: HTMLElement | null | undefined) => {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => el!.click());
  await settle();
};
const stored = () => JSON.parse(localStorage.getItem(LS_HIDDEN_AGENTS) ?? '[]') as string[];

describe('the New agent menu: hidden agents', () => {
  it('a hidden agent is gone from the menu and the others stay', async () => {
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify(['nochat']));
    await mount();
    await openMenu();
    expect(menuRowLabels()).toContain('Ready agent');
    expect(menuRowLabels()).toContain('Addon agent');
    expect(menuRowLabels()).not.toContain('No chat agent');
  });

  it('"Edit list…" opens the editor; a tick hides an agent in the menu; Back returns to the menu', async () => {
    await mount();
    await openMenu();
    expect(menuRowLabels()).toContain('Addon agent');
    await click(buttonNamed('Edit list…'));
    expect(host.querySelector('[data-testid="hidden-agents-editor"]')).toBeTruthy();
    expect(editBox('Addon agent')!.checked).toBe(true);
    await click(editBox('Addon agent'));
    expect(editBox('Addon agent')!.checked).toBe(false);
    expect(stored()).toEqual(['addonagent']);
    await click(buttonNamed('Back'));
    expect(host.querySelector('[data-testid="hidden-agents-editor"]')).toBeNull();
    expect(menuRowLabels()).not.toContain('Addon agent');
    expect(menuRowLabels()).toContain('Ready agent');
  });

  it('the last shown agent cannot be hidden: its box is locked on', async () => {
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify(['readyagent', 'addonagent', 'powershell']));
    await mount();
    await openMenu();
    await click(buttonNamed('Edit list…'));
    expect(editBox('No chat agent')!.checked).toBe(true);
    expect(editBox('No chat agent')!.disabled).toBe(true);
    await click(editBox('No chat agent'));
    expect(stored()).toEqual(['readyagent', 'addonagent', 'powershell']);
  });

  it('"Show all" brings every agent back, and is off when nothing is hidden', async () => {
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify(['addonagent', 'nochat']));
    await mount();
    await openMenu();
    await click(buttonNamed('Edit list…'));
    expect(buttonNamed('Show all')!.disabled).toBe(false);
    await click(buttonNamed('Show all'));
    expect(stored()).toEqual([]);
    expect(editBox('Addon agent')!.checked).toBe(true);
    expect(buttonNamed('Show all')!.disabled).toBe(true);
    await click(buttonNamed('Back'));
    expect(menuRowLabels()).toEqual(expect.arrayContaining(['Ready agent', 'Addon agent', 'No chat agent', 'PowerShell']));
  });
});
