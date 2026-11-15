// @vitest-environment jsdom
// "Where" in New agent (Labs `devices_enabled`), through the real Sidebar quick menu and the real phone new-chat screen:
// the pill, This PC / a device / an offline device that cannot be picked, the device's own agents and projects once picked,
// starting there through the far bridge, "Add a device…", and nothing at all while the switch is off.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { click, settle, type as typeInto } from '../settings/test-utils';
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
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function open(fake: DevicesFake, extra: { onAddDevice?: () => void; onStarted?: (...a: unknown[]) => void } = {}) {
  await act(async () =>
    root.render(
      <Sidebar
        c={fakeApi()}
        onOpenPalette={() => {}}
        ship={ship}
        devices={{
          groups: [],
          selectedKey: null,
          onOpen: () => {},
          where: { view: fake.view, api: fake, onAddDevice: extra.onAddDevice ?? (() => {}), onStarted: (extra.onStarted ?? (() => {})) as never },
        }}
      />,
    ),
  );
  await settle(4);
  await click(host.querySelector('button[aria-label="Quick start menu"]'));
  await settle(4);
}

describe('New agent: Where', () => {
  it('shows the pill with This PC chosen, and lists This PC, a device, and an offline device that cannot be picked', async () => {
    await open(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] }));
    expect(q('[data-testid="where"]')!.textContent).toContain('Where');
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('This PC');
    await click(q('[data-testid="where-pill"]'));
    const menu = q('.dev-where-menu')!;
    expect([...menu.querySelectorAll('.dev-where-row > span')].map((s) => s.textContent)).toEqual(['This PC', 'Mac mini', 'Work laptop', 'Add a device…']);
    expect(q<HTMLButtonElement>(`[data-testid="where-${NODE_MAC}"]`)!.disabled).toBe(false);
    const laptop = q<HTMLButtonElement>(`[data-testid="where-${WORK_LAPTOP.node}"]`)!;
    expect(laptop.disabled).toBe(true);
    expect(laptop.textContent).toContain('Offline.');
    // The usual menu is still there under it.
    expect(host.textContent).toContain('Codex');
  });

  it('after picking the Mac mini the agents and the projects are the Mac mini\'s own', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] });
    await open(fake);
    await click(q('[data-testid="where-pill"]'));
    await click(q(`[data-testid="where-${NODE_MAC}"]`));
    await settle(6);
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Mac mini');
    expect(fake.requests.some((r) => r.node === NODE_MAC && r.path === '/phone/new-chat')).toBe(true);
    const tiles = [...document.querySelectorAll('[data-testid="nc-agent-tile"]')].map((t) => t.textContent);
    expect(tiles).toEqual(['Claude', 'Codex'].map((n) => expect.stringContaining(n)));
    expect(q('[data-testid="nc-project-pill"]')!.textContent).toContain('app');
    expect(q('[data-testid="phone-new-chat"]')).not.toBeNull();
  });

  it('starting there goes through the far bridge and opens it', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const onStarted = vi.fn();
    await open(fake, { onStarted });
    await click(q('[data-testid="where-pill"]'));
    await click(q(`[data-testid="where-${NODE_MAC}"]`));
    await settle(6);
    await typeInto(q<HTMLTextAreaElement>('textarea')!, 'Build the dmg');
    await click(q('button.ph-comp-send'));
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/phone/chats')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { agent: 'claude', project: 'proj-app', lane: 'chat' } });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]![0]).toMatchObject({ node: NODE_MAC });
    expect(onStarted.mock.calls[0]![2]).toBe(true);
  });

  it('"Add a device…" opens the add flow', async () => {
    const onAddDevice = vi.fn();
    await open(new DevicesFake({ enabled: true }), { onAddDevice });
    await click(q('[data-testid="where-pill"]'));
    await click(q('[data-testid="where-add"]'));
    expect(onAddDevice).toHaveBeenCalledTimes(1);
  });

  it('is not drawn while the Labs switch is off', async () => {
    await open(new DevicesFake({ enabled: false, devices: [MAC_MINI] }));
    expect(q('[data-testid="where"]')).toBeNull();
    expect(host.textContent).toContain('Codex');
  });
});
