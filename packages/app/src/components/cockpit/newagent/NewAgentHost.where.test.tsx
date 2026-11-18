// @vitest-environment jsdom
// "Where" on the full New agent page (Labs `devices_enabled`), through the real NewAgentHost + NewAgentPage: the pill sits in the
// composer row before the project pill; it lists This PC, a paired device and an SSH machine; an offline device cannot be picked;
// picking the Mac swaps the folders and the agents for the Mac's own and Start goes through the device link; the place is
// remembered per project; nothing is drawn while the Labs switch is off. Only the device link and the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { UsageApi } from '../../../lib/usage';
import type { WslApi } from '../../../lib/wsl';
import { click, settle, type as typeInto } from '../../settings/test-utils';
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

/** The project picker alone chooses the PC: open it and take the first project of that PC's group. */
async function pickDevice(node = NODE_MAC) {
  await click(q('[data-testid="na-folder"]'));
  await settle(4);
  await click(q(`[data-testid="na-group-${node}"] .ck-na-item`));
  await settle(8);
}

async function open(where: WhereProps | undefined, project: { path: string; name: string } | null = null) {
  await act(async () => root.render(<NewAgentHost c={fakeApi()} where={where} project={project} />));
  await settle(6);
}

describe('New agent page: Where', () => {
  const usageOf = (usedPct: number): UsageApi => ({
    snapshot: async () => ({ refreshed_at_ms: 1, rows: [{ agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok' as const, reason: null, windows: [{ name: '5-hour', used_percent: usedPct, reset_since: false }], plan: null, observed_at_ms: 1, limited_until_ms: null, page: null }] }),
    openPage: async () => {},
    onChanged: async () => () => {},
  });
  const roomOf = (pct: number) => [{ agent_id: 'claude', agent_label: 'Claude', account_label: null, percent_left: pct, resets_at_ms: null, observed_at_ms: 1 }];

  it('suggests the PC with more room in one line, and Use it picks that PC', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, room: roomOf(85), room_at: 1 }] });
    await open(whereOf(fake, { usage: usageOf(80) }));
    expect(q('[data-testid="room-suggest"]')!.textContent).toBe('More room on Mac miniUse it');
    await click(q('[data-testid="room-use"]'));
    await settle(8);
    // The picker alone names the PC: no Where pill while another PC's page shows.
    expect(q('[data-testid="na-on-device"]')).not.toBeNull();
    expect(q('[data-testid="room-suggest"]')).toBeNull();
  });

  it('says nothing when this PC has room, or the other PC is offline', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, room: roomOf(99), room_at: 1 }] }), { usage: usageOf(20) }));
    expect(q('[data-testid="room-suggest"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await open(whereOf(new DevicesFake({ enabled: true, devices: [{ ...WORK_LAPTOP, room: roomOf(99), room_at: 1 }] }), { usage: usageOf(90) }));
    expect(q('[data-testid="room-suggest"]')).toBeNull();
  });

  it('draws the pill in the composer row, before the project pill, listing This PC, the devices and the SSH machines', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    const row = q('.ck-na-row')!;
    const pill = row.querySelector('[data-testid="where-pill"]')!;
    const project = row.querySelector('[data-testid="na-folder"]')!;
    expect(pill.textContent).toBe('Run in: Desk-PC · This PC ▾');
    expect(pill.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not also drawn above the page.
    expect(document.querySelectorAll('[data-testid="where-pill"]')).toHaveLength(1);
    await click(pill);
    await settle(4);
    expect([...q('.dev-where-menu')!.querySelectorAll('.dev-where-row > span:not(.dis-reason)')].map((s) => s.textContent)).toEqual(['Desk-PC · This PC', 'Ubuntu-Test', 'Build box']);
    // Devices are chosen by project in the picker, never here; no "Add a PC" either.
    expect(q(`[data-testid="where-${NODE_MAC}"]`)).toBeNull();
    expect(q('[data-testid="where-add"]')).toBeNull();
  });

  it('picking Ubuntu keeps the normal composer; only the Run in chip changes, and Start opens the agent inside that distro', async () => {
    const spawned: unknown[][] = [];
    const wsl = { ...fakeWsl(), spawnInLinux: async (...a: unknown[]) => (spawned.push(a), 'wsl-pane-1') } as unknown as WslApi;
    const onStartedHere = vi.fn();
    await open({ ...whereOf(new DevicesFake({ enabled: true, devices: [] }), { wsl, onStartedHere }) }, { path: 'D:\\work\\shop', name: 'shop' });
    const shape = () => ({ field: !!q('textarea.ck-na-input'), send: !!q('button.ck-na-send'), folder: q('[data-testid="na-folder"]')?.textContent, agent: !!q('[data-testid="na-agent"]') });
    const local = shape();
    await click(q('[data-testid="where-pill"]'));
    await settle(4);
    await click(q('[data-testid="where-wsl:Ubuntu-Test"]'));
    await settle(6);
    // The same page: no old form (agent buttons, folder text box, its own Start).
    expect(q('[data-testid="wsl-panel"]')).toBeNull();
    expect(q('[data-testid="place-folder"]')).toBeNull();
    expect(q('[data-testid="place-start"]')).toBeNull();
    expect(shape()).toEqual(local);
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Run in: Ubuntu-Test');
    // An agent that cannot run in this distro is greyed with a short reason, not hidden.
    await click(q('[data-testid="na-agent"]'));
    const items = [...document.querySelectorAll<HTMLButtonElement>('.ck-na-menu [role="menuitemradio"]')];
    const codex = items.find((i) => i.textContent?.includes('Codex'))!;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain("Can't run in Linux yet.");
    await click(q('[data-testid="na-agent"]'));
    // Options a Linux start cannot honour are not offered (nothing is dropped silently).
    expect(q('[data-testid="na-plus"]')).toBeNull();
    expect(q('[data-testid="na-workflow"]')).toBeNull();
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Fix the build');
    await click(q('button.ck-na-send'));
    await settle(8);
    expect(spawned).toEqual([[{ agent_type: 'claude', cwd: 'D:\\work\\shop' }, 'Ubuntu-Test']]);
    expect(onStartedHere).toHaveBeenCalledWith('wsl-pane-1');
  });

  it('an offline device is a greyed group of the project picker, and cannot be picked', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    await click(q('[data-testid="na-folder"]'));
    await settle(4);
    expect(q(`[data-testid="na-group-away-${WORK_LAPTOP.node}"]`)!.textContent).toBe('Work laptop is offline');
    expect(q(`[data-testid="na-group-${WORK_LAPTOP.node}"] .ck-na-item`)).toBeNull();
    expect(q('[data-testid="na-on-device"]')).toBeNull();
  });

  it('without Linux places or SSH machines there is no Run in pill at all', async () => {
    const w = { ...whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI] })), ssh: new SshFake({ hosts: [] }), wsl: { ...fakeWsl(), status: async () => ({ state: 'ready' as const, distros: [] }) } as unknown as WslApi };
    await open(w);
    expect(q('[data-testid="where-pill"]')).toBeNull();
    expect(q('[data-testid="na-folder"]')).not.toBeNull();
  });

  it('picking the Mac keeps the same page: the same pill row and project picker, the Mac agents and projects, and Start goes through the device link', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const onStarted = vi.fn();
    await open(whereOf(fake, { onStarted: onStarted as never }));
    await pickDevice();
    await settle(8);
    // The usual page, not the phone's screen: the same composer row, the same project and agent chips, one small label.
    expect(q('.ph')).toBeNull();
    expect(q('[data-testid="phone-new-chat"]')).toBeNull();
    expect(q('section.ck-na')).not.toBeNull();
    expect(q('[data-testid="na-on-device"]')!.textContent).toBe('on Mac mini');
    const row = q('.ck-na-row')!;
    // The Run in pill is for this PC's own Linux places and SSH machines: not drawn on another PC's page.
    expect(row.querySelector('[data-testid="where-pill"]')).toBeNull();
    expect(fake.requests.some((r) => r.node === NODE_MAC && r.path === '/pclink/agents')).toBe(true);
    // The Mac's own project is the folder; the agent chip is the first of the Mac's agents.
    expect(q('[data-testid="na-folder"]')!.textContent).toContain('app');
    expect(q('[data-testid="na-agent"]')!.textContent).toContain('Claude');
    await click(q('[data-testid="na-agent"]'));
    expect([...document.querySelectorAll('.ck-na-menu [role="menuitemradio"] .ck-na-item-row span:last-child')].map((e) => e.textContent)).toEqual(['Claude', 'Codex']);
    await click(q('[data-testid="na-agent"]'));
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Build the dmg');
    await click(q('button.ck-na-send'));
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/pclink/agents/start')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { agent: 'claude', project: 'proj-app', lane: 'chat' } });
    expect(fake.requests.find((r) => /\/messages$/.test(r.path))).toMatchObject({ node: NODE_MAC, method: 'POST', body: { text: 'Build the dmg' } });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]![0]).toMatchObject({ node: NODE_MAC });
    expect(onStarted.mock.calls[0]![2]).toBe(true);
    // The agent opens on its PC; the picker is back on This PC.
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Desk-PC · This PC');
    expect(q('[data-testid="na-on-device"]')).toBeNull();
  });

  it('draws the same page for the Mac as for This PC: the same sections, composer row chips and Start button, plus only the label', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(whereOf(fake));
    const shape = () => ({
      section: q('section.ck-na')?.getAttribute('aria-label'),
      ask: q('[data-testid="na-ask"]')?.textContent,
      chips: [...document.querySelectorAll('.ck-na-row > .ck-na-pop > [data-testid], .ck-na-row > [data-testid="where"] > [data-testid]')].map((e) => e.getAttribute('data-testid')).filter((id) => id !== 'na-plus' && id !== 'where-pill'),
      send: !!q('button.ck-na-send'),
      field: !!q('textarea.ck-na-input'),
    });
    const local = shape();
    await pickDevice();
    await settle(8);
    expect(shape()).toEqual(local);
    expect(q('[data-testid="na-on-device"]')).not.toBeNull();
  });

  it('leaves out what only exists on this PC while another PC is picked: the file and folder dialogs, copies, the home and getting-started cards', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(whereOf(fake));
    expect(q('[data-testid="na-plus"]')).not.toBeNull();
    await pickDevice();
    await settle(8);
    expect(q('[data-testid="na-plus"]')).toBeNull();
    await click(q('[data-testid="na-folder"]'));
    // The picker is grouped by device now: This PC's Add project and the PC's own, and no one-off system folder dialog.
    expect(q(`[data-testid="na-group-${NODE_MAC}"]`)!.textContent).not.toContain('other folder');
    expect(q('[data-testid="na-other-this"]')!.textContent).toBe('Choose another folder…');
    expect([...document.querySelectorAll('.ck-na-menu .ck-na-item-main > span:first-child')].map((e) => e.textContent)).toEqual(['app']);
    // The far project's pseudo path never shows.
    expect(document.querySelector('.ck-na-menu')!.textContent).not.toContain('remote:');
    expect(q('[data-testid="getting-started"]')).toBeNull();
  });

  const pickMac = async (fake: DevicesFake) => {
    await open(whereOf(fake));
    await pickDevice();
    await settle(8);
  };

  it('a device that has not let this PC work on it shows one line in place of Start and a button that really asks; nothing starts until it says yes', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }] });
    await pickMac(fake);
    expect(q('button.ck-na-send[aria-label="Start"]')).toBeNull();
    expect(q('[data-testid="na-agents-off"] .ck-na-ask-line-main')!.textContent).toBe('Starting agents on Mac mini is off.');
    expect(q('[data-testid="na-agents-ask"]')!.textContent).toBe('Ask Mac mini to allow agents');
    // Nothing was asked and nothing started just by looking.
    expect(fake.requests.some((r) => r.path === '/pclink/full-request')).toBe(false);
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
    expect(fake.requests.some((r) => r.path === '/pclink/agents/warm')).toBe(false);
    // The button is the real route: a card is raised on the far PC and this side says it is waiting.
    await click(q('[data-testid="na-agents-ask"]'));
    await settle(6);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/pclink/full-request')).toHaveLength(1);
    expect(fake.asksAt.has(NODE_MAC)).toBe(true);
    expect(q('[data-testid="na-agents-ask-waiting"]')!.textContent).toBe('Asked. Waiting for a yes at Mac mini.');
    expect(q('[data-testid="na-agents-ask"]')).toBeNull();
    expect(q('button.ck-na-send[aria-label="Start"]')).toBeNull();
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
  });

  it('the far person says yes: Start appears by itself, and starting works', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }] });
      await pickMac(fake);
      await click(q('[data-testid="na-agents-ask"]'));
      await settle(6);
      expect(q('[data-testid="na-agents-ask-waiting"]')).not.toBeNull();
      fake.grantFull(NODE_MAC);
      // While the question waits the answer is looked for every ~5 s (the idle poll is 15 s).
      await act(async () => vi.advanceTimersByTimeAsync(6100));
      await settle(6);
      expect(q('[data-testid="na-agents-off"]')).toBeNull();
      expect(q('button.ck-na-send[aria-label="Start"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused or unanswered ask is said honestly and can be tried again', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'answer' }] });
    await pickMac(fake);
    fake.askFails = true;
    await click(q('[data-testid="na-agents-ask"]'));
    await settle(6);
    expect(q('[data-testid="na-agents-ask-error"]')!.textContent).toBe('Mac mini was asked a moment ago. Try again in a few minutes.');
    expect(q('[data-testid="na-agents-ask"]')).not.toBeNull();
    expect(q('[data-testid="na-agents-ask-waiting"]')).toBeNull();
    // The far PC goes away: the ask did not go, and the page says so, not "asked".
    fake.askFails = false;
    const base = fake.request;
    fake.request = async (node: string, method: string, path: string, body?: unknown): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (path === '/pclink/full-request') throw new Error('That device is offline.');
      return base(node, method, path, body);
    };
    await click(q('[data-testid="na-agents-ask"]'));
    await settle(6);
    expect(q('[data-testid="na-agents-ask-error"]')!.textContent).toBe("Mac mini didn't answer. The question was not sent.");
    expect(q('[data-testid="na-agents-ask-waiting"]')).toBeNull();
  });

  it('a PC that cannot be reached is a greyed group of the picker that says why in visible text', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI, { ...WORK_LAPTOP, state: 'not_allowed', path: null }] });
    await open(whereOf(fake));
    await click(q('[data-testid="na-folder"]'));
    await settle(4);
    const why = q(`[data-testid="na-group-away-${WORK_LAPTOP.node}"]`)!;
    expect(why.textContent!.length).toBeGreaterThan(0);
    expect(why.textContent).toContain('Work laptop');
    expect(q(`[data-testid="na-group-${WORK_LAPTOP.node}"] .ck-na-item`)).toBeNull();
  });

  it('warms the far agent once an agent and a project are picked, and lists only far projects with one line saying so', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const base = fake.request;
    fake.request = async (node: string, method: string, path: string, body?: unknown): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (path === '/pclink/agents/warm') {
        fake.requests.push({ node, method, path, body });
        return { status: 200, body: { warming: true } };
      }
      return base(node, method, path, body);
    };
    await open(whereOf(fake));
    await pickDevice();
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/pclink/agents/warm')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { agent: 'claude', project: 'proj-app' } });
    await click(q('[data-testid="na-folder"]'));
    // Grouped by device: the Mac's group lists only the projects opened on the Mac.
    expect([...document.querySelectorAll(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item-main > span:first-child`)].map((e) => e.textContent)).toEqual(['app']);
  });

  it('does not save the agent choice of another PC, and does not show this PC saved model list for it', async () => {
    window.localStorage.setItem('pm.agent.models.live.claude', JSON.stringify({ terminal: false, default_model: null, models: ['local-only'], live: { options: [{ value: 'local-only', name: 'Local only' }, { value: 'x', name: 'X' }] } }));
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(whereOf(fake));
    await pickDevice();
    await settle(8);
    await click(q('[data-testid="na-agent"]'));
    await click([...document.querySelectorAll<HTMLElement>('.ck-na-menu [role="menuitemradio"]')].find((e) => e.textContent?.includes('Codex'))!);
    expect(window.localStorage.getItem('pm.newagent.agent')).toBeNull();
    // Picking a far project by hand does not become this PC's last project either.
    await click(q('[data-testid="na-folder"]'));
    await click(document.querySelector<HTMLElement>('.ck-na-menu [role="menuitem"]'));
    expect(window.localStorage.getItem('pm.newagent.lastProject')).toBeNull();
    // "Bring my chats" is about this PC: not offered on another PC's page.
    expect(q('[data-testid="na-starters"]')).not.toBeNull();
    expect(q('[data-testid="na-starters"]')!.textContent).not.toContain('Bring my chats');
    // The Mac answers nothing for models here: the picker is not drawn from this PC list.
    expect(document.body.textContent).not.toContain('Local only');
  });

  it('tells the person and keeps the typed text when the first message does not go, and Start again sends it to the same chat', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const base = fake.request;
    let fail = true;
    fake.request = async (node: string, method: string, path: string, body?: unknown): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (fail && method === 'POST' && /\/messages$/.test(path)) {
        fake.requests.push({ node, method, path, body });
        throw new Error('That device is offline.');
      }
      return base(node, method, path, body);
    };
    const onStarted = vi.fn();
    await open(whereOf(fake, { onStarted: onStarted as never }));
    await pickDevice();
    await settle(8);
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Keep me');
    await click(q('button.ck-na-send'));
    await settle(8);
    expect(q('.ck-na-hint')!.textContent).toContain('Mac mini started the agent, but your message did not go.');
    expect(q<HTMLTextAreaElement>('textarea.ck-na-input')!.value).toBe('Keep me');
    expect(onStarted).not.toHaveBeenCalled();
    fail = false;
    await click(q('button.ck-na-send'));
    await settle(8);
    expect(fake.requests.filter((r) => r.path === '/pclink/agents/start')).toHaveLength(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('puts the chosen model on the new chat of the Mac by the far setting name, before the first message', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const base = fake.request;
    fake.request = async (node: string, method: string, path: string, body?: unknown): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (method === 'GET' ? path.startsWith('/pclink/agents/claude/models') : path.endsWith('/config')) fake.requests.push({ node, method, path, body });
      if (method === 'GET' && path.startsWith('/pclink/agents/claude/models')) {
        return { status: 200, body: { terminal: false, default_model: 'sonnet', models: ['opus', 'sonnet'], live: { id: 'model_choice', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] } } };
      }
      if (method === 'POST' && /^\/pclink\/sessions\/[^/]+\/config$/.test(path)) return { status: 200, body: { ok: true } };
      return base(node, method, path, body);
    };
    await open(whereOf(fake));
    await pickDevice();
    await settle(10);
    expect(fake.requests.some((r) => r.path.startsWith('/pclink/agents/claude/models'))).toBe(true);
    expect(q('[data-testid="na-model"]')).not.toBeNull();
    await click(q('[data-testid="na-model"]'));
    await click([...document.querySelectorAll<HTMLElement>('.mp-menu [role="option"]')].find((o) => o.textContent?.includes('Opus'))!);
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Go');
    await click(q('button.ck-na-send'));
    await settle(10);
    const order = fake.requests.map((r) => r.path);
    const cfg = fake.requests.find((r) => /\/config$/.test(r.path));
    expect(cfg).toMatchObject({ node: NODE_MAC, method: 'POST', body: { option_id: 'model_choice', value: 'opus' } });
    expect(order.findIndex((p) => /\/config$/.test(p))).toBeGreaterThan(order.indexOf('/pclink/agents/start'));
    expect(order.findIndex((p) => /\/config$/.test(p))).toBeLessThan(order.findIndex((p) => /\/messages$/.test(p)));
  });

  it('can go back to This PC from the picker on the Mac\'s body', async () => {
    window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: 'D:/code/mine', name: 'mine' }]));
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(whereOf(fake));
    await pickDevice();
    expect(q('[data-testid="na-on-device"]')).not.toBeNull();
    await click(q('[data-testid="na-folder"]'));
    await settle(4);
    await click([...document.querySelectorAll('[data-testid="na-group-this"] .ck-na-item')].find((e) => e.textContent!.includes('mine')));
    await settle(8);
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('Desk-PC · This PC');
  });

  it('an SSH machine gets the terminal-only body with the pill kept first', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI] })));
    await click(q('[data-testid="where-pill"]'));
    await click(q('[data-testid="where-ssh:' + BUILD_BOX.id + '"]'));
    await settle(6);
    const panel = q('[data-testid="ssh-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-testid="where-pill"]')!.textContent).toContain('Build box');
    expect(panel.querySelector('[data-testid="where-pill"]')!.compareDocumentPosition(panel.querySelector('.dev-note')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).toContain('terminal');
  });

  it('remembers the last Run in place per project', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const w = whereOf(fake);
    await open(w, { path: '/work/alpha', name: 'alpha' });
    await click(q('[data-testid="where-pill"]'));
    await click(q('[data-testid="where-ssh:' + BUILD_BOX.id + '"]'));
    await settle(6);
    await act(async () => root.unmount());
    root = createRoot(host);
    // The same project opens on the SSH machine again; another project opens on This PC.
    await open(w, { path: '/work/alpha', name: 'alpha' });
    expect(q('[data-testid="ssh-panel"]')).not.toBeNull();
    await act(async () => root.render(<NewAgentHost c={fakeApi()} where={w} project={{ path: '/work/beta', name: 'beta' }} />));
    await settle(6);
    expect(q('[data-testid="ssh-panel"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('Desk-PC · This PC');
  });

  it('a remembered device that is offline now falls back to This PC', async () => {
    window.localStorage.setItem('pm.newAgent.where', JSON.stringify({ '': WORK_LAPTOP.node }));
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    expect(q('[data-testid="na-on-device"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('Desk-PC · This PC');
  });

  it('is not drawn while the Labs switch is off, or without devices at all', async () => {
    await open(whereOf(new DevicesFake({ enabled: false, devices: [MAC_MINI] })));
    expect(q('[data-testid="where"]')).toBeNull();
    expect(q('[data-testid="na-folder"]')).not.toBeNull();
    await act(async () => root.render(<NewAgentHost c={fakeApi()} />));
    await settle(4);
    expect(q('[data-testid="where"]')).toBeNull();
  });
});
