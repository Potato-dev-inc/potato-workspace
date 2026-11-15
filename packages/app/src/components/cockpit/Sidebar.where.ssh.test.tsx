// @vitest-environment jsdom
// "Where" in New agent with this PC's Linux distros and SSH machines, through the real Sidebar quick menu: the picker lists
// This PC, each WSL distro and each SSH machine (terminal only); an agent starts in the chosen distro; an SSH machine offers a
// Shell and the agents its check found, never a chat. Only the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI } from '../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../dev/ssh-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import type { WslApi } from '../../lib/wsl';
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

function fakeWsl(spawned: unknown[][] = []): WslApi {
  return {
    status: async () => ({
      state: 'ready' as const,
      distros: [
        { name: 'Ubuntu-Test', default: true, version: 2, state: 'Running' },
        { name: 'Old-One', default: false, version: 1, state: 'Stopped' },
      ],
    }),
    check: async () => {
      throw new Error('never called');
    },
    placesGet: async () => [
      { agentId: 'claude', label: 'Claude', distro: null, found: null, whyNot: null },
      { agentId: 'opencode', label: 'OpenCode', distro: null, found: null, whyNot: "OpenCode can't run in Linux from Potato Workspace yet." },
    ],
    placeSet: async () => {
      throw new Error('never called');
    },
    spawnInLinux: async (args: unknown, distro: string) => {
      spawned.push([args, distro]);
      return 'wsl-pane-1';
    },
  } as unknown as WslApi;
}

async function open(ssh: SshFake, wsl: WslApi, onStartedHere: (id: string) => void = () => {}) {
  const devices = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
  await act(async () =>
    root.render(
      <Sidebar
        c={fakeApi()}
        onOpenPalette={() => {}}
        ship={ship}
        devices={{ groups: [], selectedKey: null, onOpen: () => {}, where: { view: devices.view, api: devices, ssh, wsl, onAddDevice: () => {}, onStarted: () => {}, onStartedHere } }}
      />,
    ),
  );
  await settle(4);
  await click(host.querySelector('button[aria-label="Quick start menu"]'));
  await settle(4);
  await click(q('[data-testid="where-pill"]'));
  await settle(4);
}

describe('New agent: Where, Linux and SSH', () => {
  it('lists This PC, the version 2 Linux distros, the paired device and the SSH machines, in that order', async () => {
    await open(new SshFake({ hosts: [BUILD_BOX] }), fakeWsl());
    const rows = [...q('.dev-where-menu')!.querySelectorAll('.dev-where-row')].map((r) => [r.querySelector('span')!.textContent, r.querySelector('small')?.textContent ?? '']);
    expect(rows.map((r) => r[0])).toEqual(['This PC', 'Ubuntu-Test', 'Mac mini', 'Build box', 'Add a device…']);
    expect(rows[1]![1]).toBe('On this PC');
    expect(rows[3]![1]).toBe('SSH · terminal only');
  });

  it('picking a distro starts the chosen agent in that distro and opens the pane', async () => {
    const spawned: unknown[][] = [];
    const started: string[] = [];
    await open(new SshFake(), fakeWsl(spawned), (id) => started.push(id));
    await click(q('[data-testid="where-wsl:Ubuntu-Test"]'));
    await settle(4);
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Ubuntu-Test');
    expect(q('[data-testid="wsl-panel"]')).not.toBeNull();
    // Only an agent that can run in Linux is offered.
    expect([...document.querySelectorAll('[data-testid^="place-agent-"]')].map((b) => b.textContent)).toEqual(['Claude']);
    await typeInto(q<HTMLInputElement>('[data-testid="place-folder"]')!, 'D:\\work\\shop');
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(spawned).toEqual([[{ agent_type: 'claude', cwd: 'D:\\work\\shop' }, 'Ubuntu-Test']]);
    expect(started).toEqual(['wsl-pane-1']);
    expect(q('[data-testid="wsl-panel"]')).toBeNull();
  });

  it('a refused Linux start is said in one plain sentence and the panel stays', async () => {
    const wsl = { ...fakeWsl(), spawnInLinux: async () => Promise.reject({ code: 'WSL_AGENT_NOT_FOUND', message: 'Claude is not installed in Ubuntu-Test. Install it inside Linux, then try again.' }) } as unknown as WslApi;
    await open(new SshFake(), wsl);
    await click(q('[data-testid="where-wsl:Ubuntu-Test"]'));
    await settle(4);
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(q('[data-testid="place-error"]')!.textContent).toContain('Claude is not installed in Ubuntu-Test');
    expect(q('[data-testid="wsl-panel"]')).not.toBeNull();
  });

  it('an SSH machine offers a Shell and the agents its check found, terminal only, and starts a terminal there', async () => {
    const ssh = new SshFake({ hosts: [BUILD_BOX] });
    const started: string[] = [];
    await open(ssh, fakeWsl(), (id) => started.push(id));
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Build box');
    const panel = q('[data-testid="ssh-panel"]')!;
    expect(panel.textContent).toContain('Runs on Build box over SSH. Terminals only for now. Nothing is installed there.');
    expect(panel.textContent).toContain('Folder on Build box');
    expect([...panel.querySelectorAll('[data-testid^="place-agent-"]')].map((b) => b.textContent)).toEqual(['Shell', 'Claude', 'Codex']);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await click(q('[data-testid="place-agent-claude"]'));
    await typeInto(q<HTMLInputElement>('[data-testid="place-folder"]')!, '/srv/app');
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(ssh.opened).toEqual([{ id: 'ssh-1', agent: 'claude', folder: '/srv/app' }]);
    expect(started).toEqual(['ssh-pane-1']);
  });

  it('a Shell with no folder opens the machine without one', async () => {
    const ssh = new SshFake({ hosts: [BUILD_BOX] });
    await open(ssh, fakeWsl());
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(ssh.opened).toEqual([{ id: 'ssh-1', agent: 'shell' }]);
  });
});
