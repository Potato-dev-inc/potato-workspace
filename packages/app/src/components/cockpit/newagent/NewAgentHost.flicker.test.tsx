// @vitest-environment jsdom
// The New agent page must not flip between the normal page and a far device's page as the device list polls, and a remembered far
// device is never silently active on a new launch.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI } from '../../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { Device, DevicesView } from '../../../lib/devices';
import type { WslApi } from '../../../lib/wsl';
import { click, settle } from '../../settings/test-utils';
import type { WhereProps } from '../../devices/NewAgentWhere';
import { NewAgentHost } from './NewAgentHost';

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
  window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: 'D:/code/mine', name: 'mine' }]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
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
    newAgent: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
function fakeWsl(): WslApi {
  return {
    status: async () => ({ state: 'ready' as const, distros: [] }),
    placesGet: async () => [],
    spawnInLinux: async () => 'p',
  } as unknown as WslApi;
}
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function whereWith(fake: DevicesFake, state: Device['state']): WhereProps {
  const view: DevicesView = { ...fake.view, devices: fake.view.devices.map((d) => (d.node === MAC_MINI.node ? { ...d, state } : d)) };
  return { view, api: fake, ssh: new SshFake({ hosts: [BUILD_BOX] }), wsl: fakeWsl(), onAddDevice: () => {}, onStarted: () => {} };
}
async function render(where: WhereProps) {
  await act(async () => root.render(<NewAgentHost c={fakeApi()} where={where} project={null} />));
  await settle(6);
}
async function pickMac(fake: DevicesFake) {
  await click(q('[data-testid="na-folder"]'));
  await settle(4);
  await click(q(`[data-testid="na-group-${MAC_MINI.node}"] .ck-na-item`));
  await settle(8);
  expect(q('[data-testid="na-on-device"]')).not.toBeNull();
  void fake;
}

describe('New agent page: no flicker between This PC and a device', () => {
  it('does not restore a remembered far device on mount', async () => {
    window.localStorage.setItem('pm.newAgent.where', JSON.stringify({ '': MAC_MINI.node }));
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await render(whereWith(fake, 'online'));
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    expect(q('[data-testid="where-unreachable"]')).toBeNull();
  });

  it('keeps the same body on checking and again online, then says once that the device is not reachable', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await render(whereWith(fake, 'online'));
    await pickMac(fake);
    for (const s of ['unknown', 'online', 'unknown'] as const) {
      await render(whereWith(fake, s));
      expect(q('[data-testid="na-on-device"]')).not.toBeNull();
      expect(q('[data-testid="where-unreachable"]')).toBeNull();
    }
    await render(whereWith(fake, 'offline'));
    expect(q('[data-testid="where-unreachable"]')!.textContent).toContain('Mac mini is not reachable');
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    // Further polls do not change the page; a device that comes back does not flip it on by itself mid-way (it is the same pick).
    await render(whereWith(fake, 'unknown'));
    expect(q('[data-testid="where-unreachable"]')).not.toBeNull();
    await render(whereWith(fake, 'asleep'));
    expect(document.querySelectorAll('[data-testid="where-unreachable"]')).toHaveLength(1);
  });

  it('a device that is still checking after the grace period is unreachable', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await render(whereWith(fake, 'online'));
    await pickMac(fake);
    await render(whereWith(fake, 'unknown'));
    expect(q('[data-testid="na-on-device"]')).not.toBeNull();
    now += 11_000;
    await render(whereWith(fake, 'unknown'));
    expect(q('[data-testid="where-unreachable"]')).not.toBeNull();
  });

  it('Use This PC goes back to the normal page with the This PC chip', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await render(whereWith(fake, 'online'));
    await pickMac(fake);
    await render(whereWith(fake, 'offline'));
    await click(q('[data-testid="where-use-this-pc"]'));
    await settle(6);
    expect(q('[data-testid="where-unreachable"]')).toBeNull();
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    expect(q('[data-testid="na-folder"]')).not.toBeNull();
    // Coming back online does not pull the page onto the device again.
    await render(whereWith(fake, 'online'));
    expect(q('[data-testid="na-on-device"]')).toBeNull();
  });
});
