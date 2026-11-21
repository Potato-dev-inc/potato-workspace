// @vitest-environment jsdom
// The sidebar's one Projects list (Labs `devices_enabled`): this PC's project has no badge, another Potato PC's project has
// that PC's name as its badge, an SSH project has `ssh (name)`, there is no device section, and a click on another PC's agent
// row calls the same open handler as before. Through the real Sidebar and the real device hook; only the command layer is fake.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { sshLocation } from '../../lib/projectLocation';
import { writeProjects } from '../../lib/sidebarProjects';
import { useDeviceGroups, type RemoteRow } from '../devices/useDeviceGroups';
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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
});

function fakeApi(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
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
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};

const onOpen = vi.fn<(row: RemoteRow) => void>();

/** CockpitApp's wiring in small: the device hook feeds the sidebar's devices, and a row click calls the open handler. */
function Screen({ fake }: { fake: DevicesFake }) {
  const groups = useDeviceGroups(fake);
  return (
    <Sidebar
      c={fakeApi()}
      onOpenPalette={() => {}}
      ship={ship}
      devices={groups.enabled ? { groups: groups.groups, selectedKey: null, onOpen, onRetry: groups.refresh } : undefined}
    />
  );
}

beforeEach(() => {
  onOpen.mockReset();
  // Two added projects on this PC: a local folder, and an SSH machine's folder (its location is saved with it).
  writeProjects([{ path: '/work/alpha' }, { path: '/work/beta', name: 'Beta', location: sshLocation('h1', 'Build box') }]);
});

describe('sidebar: one Projects list with location badges', () => {
  it('local has no badge, another PC shows its name, SSH shows ssh (name), and there is no device section', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    await act(async () => root.render(<Screen fake={fake} />));
    await flush();

    const cards = [...host.querySelectorAll<HTMLElement>('.ck-proj')];
    const card = (name: string) => cards.find((c) => c.getAttribute('aria-label') === name)!;
    // One local project without a badge.
    expect(card('alpha')).toBeDefined();
    expect(card('alpha').querySelector('[data-testid="proj-badge"]')).toBeNull();
    // The SSH project with its badge.
    expect(card('Beta').querySelector('[data-testid="proj-badge"]')!.textContent).toBe('ssh (Build box)');
    // The other PC's project with the device name badge, and its agent rows underneath.
    const remote = cards.find((c) => c.dataset.remoteNode === NODE_MAC)!;
    expect(remote.querySelector('[data-testid="proj-badge"]')!.textContent).toBe('Mac mini');
    const rows = [...remote.querySelectorAll<HTMLButtonElement>(`[data-pane-row^="dev:${NODE_MAC}:"]`)];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.classList.contains('ck-row')).toBe(true);

    // No device section, no "This PC" heading, no separate per-PC group.
    expect(host.querySelector('[data-testid^="device-group-"]')).toBeNull();
    expect(host.querySelector('.dev-group-head')).toBeNull();
    expect(host.querySelector('[data-testid="this-pc-head"]')).toBeNull();
    // Two badges in all: the SSH project and the other PC (this PC has none).
    expect(host.querySelectorAll('[data-testid="proj-badge"]')).toHaveLength(2);
  });

  it('clicking another PC agent row calls the same open handler with that row', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    await act(async () => root.render(<Screen fake={fake} />));
    await flush();
    const row = host.querySelector<HTMLButtonElement>(`[data-pane-row="dev:${NODE_MAC}:p1"]`)!;
    expect(row).not.toBeNull();
    await act(async () => row.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ key: `dev:${NODE_MAC}:p1`, node: NODE_MAC, paneId: 'p1' });
  });
});
