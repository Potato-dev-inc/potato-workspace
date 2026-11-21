// @vitest-environment jsdom
// A project on another PC has the SAME header as a folder on this PC: the caret button, "New agent in", and "More". "+" opens the usual
// New agent page on that project and that PC; the menu shows what cannot work there greyed with the one reason. Through the real Sidebar.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';
import { useDeviceGroups } from '../devices/useDeviceGroups';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LS_SIDEBAR_PROJECTS, JSON.stringify([{ path: 'C:\\work\\shop' }]));
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const PANE = { info: { id: 'a', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null }, status: 'idle' };
const fakeApi = () =>
  ({
    registry: { paneList: [PANE], panes: new Map([['a', PANE]]), initialReady: true },
    names: new Map([['a', 'Alpha']]),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
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
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  }) as unknown as CockpitApi;
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;
const onOpenNewAgent = vi.fn();

function Screen({ fake }: { fake: DevicesFake }) {
  const groups = useDeviceGroups(fake);
  return <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} onOpenNewAgent={onOpenNewAgent} devices={groups.enabled ? { groups: groups.groups, selectedKey: null, onOpen: () => {}, onRetry: groups.refresh } : undefined} />;
}
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};
const head = (sel: string) => host.querySelector<HTMLElement>(`${sel} .ck-proj-head`)!;
const far = () => `.ck-proj[data-remote-node="${NODE_MAC}"]`;
/** The head's buttons with the project's name taken out of their labels: what a person can press, in order. */
const buttons = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].map((b) => `${b.className}|${(b.getAttribute('aria-label') ?? b.title).split(name).join('{name}')}`);

describe('sidebar: the header of a project on another PC', () => {
  beforeEach(async () => {
    onOpenNewAgent.mockClear();
    await act(async () => root.render(<Screen fake={new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } })} />));
    await flush();
  });

  it('has the same buttons as a folder of this PC', () => {
    const farName = head(far()).querySelector('.ck-proj-name')!.textContent!;
    expect(farName).toBeTruthy();
    const local = buttons(head('.ck-proj[aria-label="shop"]'), 'shop');
    expect(local.length).toBe(3);
    expect(buttons(head(far()), farName)).toEqual(local);
  });

  it('"+" opens New agent on that project and that PC', async () => {
    await act(async () => head(far()).querySelector<HTMLButtonElement>('button[aria-label^="New agent in"]')!.click());
    expect(onOpenNewAgent).toHaveBeenCalledTimes(1);
    expect(onOpenNewAgent.mock.calls[0]![0]).toMatchObject({ node: NODE_MAC, path: 'remote:p-/Users/me/app' });
  });

  it('More lists the same items, greyed with the one reason', async () => {
    await act(async () => head(far()).querySelector<HTMLButtonElement>('button[aria-label^="More for"]')!.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.firstChild?.textContent)).toEqual(['Rename', 'Remove from sidebar']);
    expect(items.every((i) => i.disabled)).toBe(true);
    expect(items.map((i) => i.querySelector('.dis-reason')?.textContent)).toEqual(['Not on Mac mini yet', 'Not on Mac mini yet']);
  });
});
