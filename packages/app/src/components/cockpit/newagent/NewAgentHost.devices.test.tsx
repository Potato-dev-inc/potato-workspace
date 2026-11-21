// @vitest-environment jsdom
// The New agent project picker grouped by device, through the real NewAgentHost + NewAgentPage + NewAgentWhere: This PC first as
// "<name> (this PC)", then each other PC under its own name, every group ending with its own Add project. A folder of another PC
// starts the agent there; an offline PC is a greyed group; a PC that lets this PC only watch shows the plain line in place of Start;
// Add project of another PC is a sheet where one click on a project opens it, and Browse folders is for Full only.
// Only the device link and the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_LAPTOP, NODE_MAC, WORK_LAPTOP } from '../../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { UsageApi } from '../../../lib/usage';
import type { WslApi } from '../../../lib/wsl';
import { click, settle, type as typeInto } from '../../settings/test-utils';
import type { WhereProps } from '../../devices/NewAgentWhere';
import { NewAgentHost } from './NewAgentHost';
import { NewAgentPage } from './NewAgentPage';
import { HostProvider } from '../../../lib/host/context';
import { farHost } from '../../../lib/host/far';
import { localHost } from '../../../lib/host/local';
import { makePcLinkClient } from '../../../lib/runtime/pclink';
import { resetAgentRegistryCache } from '../../../lib/agentRegistry';
import { forceShowTerminals } from '../../../lib/showTerminals';

// This PC's commands, answered by the same fake that answers the far PC's call rows: the page must draw the same DOM from either host.
const tauri = vi.hoisted(() => ({ answer: null as null | ((cmd: string, args: unknown) => Promise<unknown>) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (cmd: string, args: unknown) => (tauri.answer ? tauri.answer(cmd, args) : Promise.reject(new Error('no desktop shell'))) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

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
    newAgent: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function fakeWsl(): WslApi {
  return {
    status: async () => ({ state: 'ready' as const, distros: [{ name: 'Ubuntu-Test', default: true, version: 2, state: 'Running' }] }),
    check: async () => {
      throw new Error('never called');
    },
    placesGet: async () => [{ agentId: 'claude', label: 'Claude', distro: null, found: null, whyNot: null }],
    placeSet: async () => {
      throw new Error('never called');
    },
    spawnInLinux: async () => 'wsl-pane-1',
  } as unknown as WslApi;
}

function whereOf(fake: DevicesFake, extra: Partial<WhereProps> = {}): WhereProps {
  return { view: fake.view, api: fake, ssh: new SshFake({ hosts: [BUILD_BOX] }), wsl: fakeWsl(), onAddDevice: () => {}, onStarted: () => {}, ...extra };
}

async function open(where: WhereProps | undefined, project: { path: string; name: string } | null = null) {
  await act(async () => root.render(<NewAgentHost c={fakeApi()} where={where} project={project} />));
  await settle(6);
}

const BILLING = { id: 'p-bill', name: 'billing-service', state: 'repo' };
const MOBILE = { id: 'p-mob', name: 'mobile-app', state: 'folder' };
const names = (el: Element | null) => [...(el?.querySelectorAll('.ck-na-item-main > span:first-child') ?? [])].map((e) => e.textContent);

function laptop(extra: Partial<typeof MAC_MINI> = {}) {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, ...extra }, WORK_LAPTOP] });
  fake.projectsOf[NODE_MAC] = [BILLING, MOBILE];
  return fake;
}
const openPicker = async () => {
  await click(q('[data-testid="na-folder"]'));
  await settle(6);
};

describe('New agent project picker grouped by device', () => {
  it('lists This PC and every other PC as groups, each ending with its own Add project; an offline PC is greyed and says so', async () => {
    await open(whereOf(laptop()));
    await openPicker();
    expect(q('[data-testid="na-group-this"] .ck-na-cap')!.textContent).toBe('Desk-PC (this PC)');
    expect(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-cap`)!.textContent).toBe('Mac mini');
    expect(names(q(`[data-testid="na-group-${NODE_MAC}"]`))).toEqual(['billing-service', 'mobile-app']);
    // Each usable group ends with Add project; the far projects show no path.
    expect(q('[data-testid="na-add-this"]')!.textContent).toBe('Add project…');
    expect(q(`[data-testid="na-add-${NODE_MAC}"]`)!.textContent).toBe('Add project…');
    expect(q(`[data-testid="na-group-${NODE_MAC}"]`)!.lastElementChild!.className).toContain('ck-na-foot');
    expect(q('[data-testid="na-groups"]')!.textContent).not.toContain('remote:');
    // The offline PC: a greyed group with one line, no Add project, and nothing was asked of it.
    const off = q(`[data-testid="na-group-${NODE_LAPTOP}"]`)!;
    expect(off.className).toContain('is-away');
    expect(q(`[data-testid="na-group-away-${NODE_LAPTOP}"]`)!.textContent).toBe('Work laptop is offline');
    expect(q(`[data-testid="na-add-${NODE_LAPTOP}"]`)).toBeNull();
  });

  it('asks only the PCs that can be reached for their projects', async () => {
    const fake = laptop();
    await open(whereOf(fake));
    expect(fake.requests.filter((r) => r.path === '/pclink/projects').map((r) => r.node)).toEqual([NODE_MAC]);
  });

  it('picking a project of another PC starts the agent there, with that project, in one click', async () => {
    const fake = laptop();
    const onStarted = vi.fn();
    await open(whereOf(fake, { onStarted: onStarted as never }));
    await openPicker();
    await click(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`));
    await settle(8);
    expect(q('[data-testid="na-on-device"]')!.textContent).toBe('on Mac mini');
    expect(q('[data-testid="na-folder"]')!.textContent).toContain('billing-service');
    // The Run in pill stays, now on the PC the project is on.
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Run in: Mac mini');
    // Another PC's start is a chat: no Chat/Terminal switch (its terminal is only a plain screen).
    expect(q('.ck-na-seg')).toBeNull();
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Fix the invoice total');
    await click(q('button.ck-na-send'));
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/pclink/agents/start')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { agent: 'claude', project: 'p-bill', lane: 'chat' } });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('from another PC the picker still lists This PC first, and a project of This PC takes the page back here', async () => {
    window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: 'D:/code/pm-night', name: 'pm-night' }]));
    const fake = laptop();
    await open(whereOf(fake));
    await openPicker();
    await click(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`));
    await settle(8);
    expect(q('[data-testid="na-on-device"]')).not.toBeNull();
    await openPicker();
    expect(q('[data-testid="na-group-this"] .ck-na-cap')!.textContent).toBe('Desk-PC (this PC)');
    // The project of the PC that is open says so.
    expect(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item-hint`)!.textContent).toBe('in use');
    expect(names(q('[data-testid="na-group-this"]'))).toContain('pm-night');
    await click([...document.querySelectorAll('[data-testid="na-group-this"] .ck-na-item')].find((e) => e.textContent!.includes('pm-night')));
    await settle(8);
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('This PC');
  });

  it('a PC that lets this PC only watch: its group is there, and Start is replaced by the plain line and the real Ask button', async () => {
    const fake = laptop({ level: 'watch' });
    await open(whereOf(fake));
    await openPicker();
    expect(names(q(`[data-testid="na-group-${NODE_MAC}"]`))).toEqual(['billing-service', 'mobile-app']);
    await click(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`));
    await settle(8);
    expect(q('button.ck-na-send[aria-label="Start"]')).toBeNull();
    expect(q('[data-testid="na-agents-off"] .ck-na-ask-line-main')!.textContent).toBe('Starting agents on Mac mini is off.');
    expect(q('[data-testid="na-agents-ask"]')!.textContent).toBe('Ask Mac mini to allow agents');
    // The Ask is a real button where Start was; the sentence and the sign-in line are under the box.
    const ask = q('[data-testid="na-agents-ask"]')!;
    expect(ask.tagName).toBe('BUTTON');
    expect(ask.closest('.ck-na-row')).not.toBeNull();
    expect(q('[data-testid="na-agents-off"]')!.closest('.ck-na-row')).toBeNull();
    expect(q('[data-testid="na-runs-on"]')!.textContent).toBe('Runs on Mac mini with its Claude sign-in.');
    await click(ask);
    await settle(6);
    expect(fake.requests.filter((r) => r.path === '/pclink/full-request')).toHaveLength(1);
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
  });

  it('Add project of another PC opens a sheet whose project, clicked once, opens at once (no Open button)', async () => {
    const fake = laptop();
    await open(whereOf(fake));
    await openPicker();
    await click(q(`[data-testid="na-add-${NODE_MAC}"]`));
    await settle(6);
    expect(q('[data-testid="folder-sheet-title"]')!.textContent).toBe('Open a folder on Mac mini');
    expect(q('[data-testid="folder-sheet-open"]')).toBeNull();
    expect([...document.querySelectorAll('[data-testid^="folder-sheet-project-"]')].map((e) => e.textContent)).toEqual(['billing-service', 'mobile-app']);
    await click(q('[data-testid="folder-sheet-project-p-mob"]'));
    await settle(8);
    expect(q('[data-testid="folder-sheet-title"]')).toBeNull();
    expect(q('[data-testid="na-on-device"]')!.textContent).toBe('on Mac mini');
    expect(q('[data-testid="na-folder"]')!.textContent).toContain('mobile-app');
  });

  it('Browse folders is offered at Full: places, folders, and the folder you are in opens as a project there', async () => {
    const fake = laptop();
    fake.browseTree[NODE_MAC] = { roots: [{ id: 'r-home', name: 'Home' }], dirs: { 'r-home|': ['code', 'notes'], 'r-home|code': ['invoice-importer'], 'r-home|code/invoice-importer': [] } };
    await open(whereOf(fake));
    await openPicker();
    await click(q(`[data-testid="na-add-${NODE_MAC}"]`));
    await settle(6);
    await click(q('[data-testid="folder-sheet-browse"]'));
    await settle(6);
    await click(q('[data-testid="folder-sheet-root-r-home"]'));
    await settle(6);
    expect(q('[data-testid="folder-sheet-trail"]')!.textContent).toBe('Home');
    expect([...document.querySelectorAll('[data-testid^="folder-sheet-dir-"]')].map((e) => e.textContent)).toEqual(['code', 'notes']);
    // Opening needs a folder inside the place: no Open button at the place itself.
    expect(q('[data-testid="folder-sheet-open"]')).toBeNull();
    await click(q('[data-testid="folder-sheet-dir-code"]'));
    await settle(6);
    await click(q('[data-testid="folder-sheet-dir-invoice-importer"]'));
    await settle(6);
    expect(q('[data-testid="folder-sheet-trail"]')!.textContent).toBe('Home / code / invoice-importer');
    expect(q('[data-testid="folder-sheet-open"]')!.textContent).toBe('Open invoice-importer');
    await click(q('[data-testid="folder-sheet-open"]'));
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/pclink/projects/open')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { root: 'r-home', sub: 'code/invoice-importer' } });
    // Only names and ids travelled.
    expect(JSON.stringify(fake.requests.filter((r) => r.path.startsWith('/pclink/browse')))).not.toMatch(/[A-Za-z]:|\/Users\//);
    expect(q('[data-testid="folder-sheet-title"]')).toBeNull();
    expect(q('[data-testid="na-folder"]')!.textContent).toContain('invoice-importer');
  });

  it('below Full there is no Browse folders, and the sheet says why in one line', async () => {
    const fake = laptop({ level: 'answer' });
    await open(whereOf(fake));
    await openPicker();
    await click(q(`[data-testid="na-add-${NODE_MAC}"]`));
    await settle(6);
    expect(q('[data-testid="folder-sheet-browse"]')).toBeNull();
    expect(q('[data-testid="folder-sheet-needs-full"]')!.textContent).toContain('Can work on this PC');
    expect(fake.requests.some((r) => r.path.startsWith('/pclink/browse'))).toBe(false);
  });

  it('This PC group keeps the one-off Choose another folder, and a folder both saved and running is listed once', async () => {
    window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: 'D:/code/dup', name: 'dup' }, { path: 'D:/code/dup', name: 'dup' }]));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await open(whereOf(laptop()));
    await openPicker();
    expect(q('[data-testid="na-other-this"]')!.textContent).toBe('Choose another folder…');
    expect(names(q('[data-testid="na-group-this"]')).filter((n) => n === 'dup')).toHaveLength(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    err.mockRestore();
  });

  it('without Devices the picker is the one it always was', async () => {
    await open(undefined);
    await openPicker();
    expect(q('[data-testid="na-groups"]')).toBeNull();
  });
});


// P2.1: the page reads its agents, lanes, folders, models, default models and pins through `useHost()`.
describe('New agent page through a host', () => {
  const html = () => host.innerHTML;
  const render = async (hostValue: typeof localHost) => {
    await act(async () => root.render(<HostProvider host={hostValue}><NewAgentPage panes={[]} needs={[]} onStart={async () => undefined} onOpenPane={() => {}} /></HostProvider>));
    await settle(10);
  };
  const farOf = (fake: DevicesFake) => farHost(makePcLinkClient(NODE_MAC, fake), fake, { name: 'Mac mini' });
  /** This PC's side: its Tauri commands are answered by the call rows of `fake`, so only the host differs. */
  const localOf = (fake: DevicesFake) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    tauri.answer = async (cmd, args) => {
      const r = await fake.request(NODE_MAC, 'POST', `/pclink/call/${cmd}`, args);
      if (r.status !== 200) throw new Error(`${cmd}: ${r.status}`);
      return r.body;
    };
    resetAgentRegistryCache();
  };
  beforeEach(() => forceShowTerminals(false));
  afterEach(() => {
    forceShowTerminals(null);
    tauri.answer = null;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    resetAgentRegistryCache();
  });

  it('draws the same page from this PC and from a far PC that answers the same rows', async () => {
    const fake = laptop();
    localOf(fake);
    await render(localHost);
    const here = html();
    const agentsHere = names(await openAgentMenu());
    await act(async () => root.render(<div />));
    resetAgentRegistryCache();
    await render(farOf(fake));
    expect(html()).toBe(here);
    expect(names(await openAgentMenu())).toEqual(agentsHere);
    expect(agentsHere).toEqual(['Claude', 'Codex']);
    // It all came through the call rows; the old list routes are not used.
    const asked = fake.requests.filter((r) => r.path.startsWith('/pclink/call/')).map((r) => r.path.replace('/pclink/call/', ''));
    expect(asked).toEqual(expect.arrayContaining(['agents_list', 'agent_lane_get', 'project_recent', 'agent_default_models']));
    expect(fake.requests.some((r) => r.path === '/pclink/agents' || r.path === '/pclink/projects')).toBe(false);
  });

  it('a far PC with only Codex and OpenCode ready has exactly those ready; the others are listed with the same "not installed" note as here, never hidden', async () => {
    const fake = laptop();
    // The registry of that PC, as `agents_list` answers it: every agent, installed or not.
    fake.agentsOf[NODE_MAC] = [{ id: 'claude', label: 'Claude', installed: false }, { id: 'codex', label: 'Codex' }, { id: 'opencode', label: 'OpenCode' }, { id: 'cursor_agent', label: 'Cursor', installed: false }];
    await render(farOf(fake));
    expect(names(await openAgentMenu())).toEqual(['Claude', 'Codex', 'OpenCode', 'Cursor']);
    const rows = [...document.querySelectorAll('.ck-na-item')].filter((e) => e.getAttribute('role') === 'menuitemradio');
    const ready = rows.filter((e) => e.querySelector('.ck-na-item-hint')?.textContent === 'ready').map((e) => e.querySelector('.ck-na-item-main')?.textContent);
    expect(ready).toEqual(['Codex', 'OpenCode']);
    expect(rows.filter((e) => e.querySelector('.ck-na-item-hint')?.textContent === 'not installed').map((e) => e.querySelector('.ck-na-item-main')?.textContent)).toEqual(['Claude', 'Cursor']);
    // The page starts on the first ready one, like here.
    expect(q('[data-testid="na-agent"]')!.textContent).toContain('Codex');
  });

  it('starts on the far PC newest folder, read by handle (never a path)', async () => {
    const fake = laptop();
    await render(farOf(fake));
    expect(q('[data-testid="na-folder"]')!.textContent).toContain('billing-service');
    expect(fake.requests.find((r) => r.path === '/pclink/call/project_recent')).toMatchObject({ node: NODE_MAC, method: 'POST' });
    expect(host.textContent).not.toMatch(/[A-Za-z]:[\/]|\/Users\//);
  });
});

async function openAgentMenu() {
  await click(q('[data-testid="na-agent"]'));
  await settle(6);
  return document.body;
}
