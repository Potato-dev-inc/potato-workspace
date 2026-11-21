// @vitest-environment jsdom
// An agent CHAT on an SSH machine, through the real Sidebar quick menu: Chat is the first choice, the folder becomes a project
// badged `ssh (name)` in the Projects list, and the pane opens. Only the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI } from '../../dev/devices-fixtures';
import { CHAT_BOX, SshFake } from '../../dev/ssh-fixtures';
import { remotePaneHost } from '../../lib/remotePanes';
import { savedPlace } from '../../lib/newAgentPlace';
import { writeProjects } from '../../lib/sidebarProjects';
import { remoteProjectPath, sshLocation } from '../../lib/projectLocation';
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


describe('New agent: a chat on an SSH machine', () => {
  it('offers Chat first, starts the chat in the typed folder, shows the folder as a project with the ssh badge, and opens the pane', async () => {
    const ssh = new SshFake({ hosts: [CHAT_BOX] });
    const started: string[] = [];
    await open(ssh, fakeWsl(), (id) => started.push(id));
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    const panel = q('[data-testid="ssh-panel"]')!;
    expect(q('[data-testid="ssh-mode-chat"]')!.getAttribute('aria-checked')).toBe('true');
    expect(panel.textContent).toContain("uses that computer's own sign-in");
    expect(panel.textContent).toContain('Open a terminal to Build box once');
    expect([...panel.querySelectorAll('[data-testid^="place-agent-"]')].map((b) => b.textContent)).toEqual(['Claude', 'Codex']);
    await click(q('[data-testid="place-agent-codex"]'));
    await typeInto(q<HTMLInputElement>('[data-testid="place-folder"]')!, "/srv/my app's code");
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(ssh.chats).toEqual([{ id: 'ssh-1', agent: 'codex', folder: "/srv/my app's code" }]);
    expect(ssh.opened).toEqual([]);
    expect(started).toEqual(['ssh-chat-1']);
    // The pane is known to be on that machine, so no local file, change or branch view is built from it.
    // The next New agent for this folder opens on this machine again.
    expect(savedPlace(remoteProjectPath('ssh-1', "/srv/my app's code"))).toBe('ssh:ssh-1');
    expect(remotePaneHost('ssh-chat-1')).toEqual({ hostId: 'ssh-1', name: 'Build box' });
    // The folder is now a project of the Projects list, badged `ssh (Build box)`, without leaving the sidebar.
    const saved = JSON.parse(window.localStorage.getItem('pm.sidebar.projects') ?? '[]') as { path: string; location?: { kind: string; host_id: string; name: string } }[];
    expect(saved).toEqual([{ path: remoteProjectPath('ssh-1', "/srv/my app's code"), location: { kind: 'ssh', host_id: 'ssh-1', name: 'Build box' } }]);
    await settle(4);
    const card = [...host.querySelectorAll<HTMLElement>('.ck-proj')].find((c) => c.getAttribute('aria-label') === "my app's code");
    expect(card, 'the project row').toBeDefined();
    expect(card!.querySelector('[data-testid="proj-badge"]')!.textContent).toBe('ssh (Build box)');
  });

  it('a chat needs a folder: one plain sentence, nothing starts and no project is added', async () => {
    const ssh = new SshFake({ hosts: [CHAT_BOX] });
    await open(ssh, fakeWsl());
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(q('[data-testid="place-error"]')!.textContent).toContain('Type the folder on Build box to work in');
    expect(ssh.chats).toEqual([]);
    expect(window.localStorage.getItem('pm.sidebar.projects')).toBeNull();
  });

  it('a refused start says why (the host key) and adds no project', async () => {
    const ssh = new SshFake({ hosts: [CHAT_BOX] });
    ssh.chatError = "Connect once in a terminal first so this computer's key is remembered.";
    const started: string[] = [];
    await open(ssh, fakeWsl(), (id) => started.push(id));
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    await typeInto(q<HTMLInputElement>('[data-testid="place-folder"]')!, '/srv/app');
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(q('[data-testid="place-error"]')!.textContent).toContain("Connect once in a terminal first so this computer's key is remembered.");
    expect(started).toEqual([]);
    expect(window.localStorage.getItem('pm.sidebar.projects')).toBeNull();
  });

  it('Terminal is still one click away and opens a terminal, not a chat', async () => {
    const ssh = new SshFake({ hosts: [CHAT_BOX] });
    const started: string[] = [];
    await open(ssh, fakeWsl(), (id) => started.push(id));
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    await click(q('[data-testid="ssh-mode-terminal"]'));
    await settle(2);
    expect([...document.querySelectorAll('[data-testid^="place-agent-"]')].map((b) => b.textContent)).toEqual(['Shell', 'Claude', 'Codex']);
    await typeInto(q<HTMLInputElement>('[data-testid="place-folder"]')!, '/srv/app');
    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(ssh.opened).toEqual([{ id: 'ssh-1', agent: 'shell', folder: '/srv/app' }]);
    expect(ssh.chats).toEqual([]);
    expect(window.localStorage.getItem('pm.sidebar.projects')).toBeNull();
  });

  it('a machine whose agents cannot chat shows no Chat switch (terminal only, as before)', async () => {
    const ssh = new SshFake({ hosts: [{ ...CHAT_BOX, chatAgents: [] }] });
    await open(ssh, fakeWsl());
    await click(q('[data-testid="where-ssh:ssh-1"]'));
    await settle(4);
    expect(q('[data-testid="ssh-mode-chat"]')).toBeNull();
    expect(q('[data-testid="ssh-panel"]')!.textContent).toContain('Terminals only for now');
  });

  it('the small quick-start menu never starts a local agent in a project that lives on an SSH machine', async () => {
    writeProjects([{ path: remoteProjectPath('ssh-1', '/srv/app'), name: 'App', location: sshLocation('ssh-1', 'Build box') }]);
    const api = fakeApi();
    const newAgent = vi.fn();
    (api as unknown as { newAgent: unknown }).newAgent = newAgent;
    await act(async () => root.render(<Sidebar c={api} onOpenPalette={() => {}} ship={ship} />));
    await settle(4);
    await click(q('[data-testid="proj-new-agent"]'));
    await settle(2);
    expect(newAgent).not.toHaveBeenCalled();
    expect(api.notify).toHaveBeenCalledWith('This project is on Build box. Open New agent, pick Build box under Where, and start a chat there.');
  });

  it('opening New agent for that project (the full page) is handed the project, which opens on its machine', async () => {
    writeProjects([{ path: remoteProjectPath('ssh-1', '/srv/app'), name: 'App', location: sshLocation('ssh-1', 'Build box') }]);
    const onOpenNewAgent = vi.fn();
    await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} onOpenNewAgent={onOpenNewAgent} />));
    await settle(4);
    await click(q('[data-testid="proj-new-agent"]'));
    expect(onOpenNewAgent).toHaveBeenCalledWith({ path: remoteProjectPath('ssh-1', '/srv/app'), name: 'App' });
  });

  it('two machines with the same folder are two projects, each with its own badge', async () => {
    writeProjects([
      { path: '/srv/app' },
      { path: remoteProjectPath('ssh-1', '/srv/app'), location: sshLocation('ssh-1', 'Build box') },
      { path: remoteProjectPath('ssh-2', '/srv/app'), location: sshLocation('ssh-2', 'Lab') },
    ]);
    await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} />));
    await settle(4);
    const cards = [...host.querySelectorAll<HTMLElement>('.ck-proj')].filter((c) => c.getAttribute('aria-label') === 'app');
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.querySelector('[data-testid="proj-badge"]')?.textContent ?? null).sort()).toEqual([null, 'ssh (Build box)', 'ssh (Lab)'].sort());
  });
});
