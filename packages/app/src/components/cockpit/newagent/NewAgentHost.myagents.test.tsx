// @vitest-environment jsdom
// "Use my own agents" (P6.1) on the far New agent page, through the real NewAgentHost + NewAgentPage: the section is at the end of the agent
// list of ANOTHER PC's page only, lists this PC's agents with a lend spec ("Claude (my sign-in)") even when that PC has the same agent, and a
// pick makes the lend by THIS PC's own click (its own command), then the far start carries `account: lend:<grant>`. Only the PC link and
// this PC's commands are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC } from '../../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { WslApi } from '../../../lib/wsl';
import { click, settle, type as typeInto } from '../../settings/test-utils';
import type { WhereProps } from '../../devices/NewAgentWhere';
import { NewAgentHost } from './NewAgentHost';

const tauri = vi.hoisted(() => ({ calls: [] as { cmd: string; args: unknown }[], lendOn: true, offer: { offerRef: 'ref-1', profileId: 'lp1', profileName: 'Work Claude', secs: 43200, grantId: null as string | null }, offerError: null as string | null, terminalOnly: false }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown) => {
    tauri.calls.push({ cmd, args });
    if (cmd === 'lend_state') {
      return { enabled: tauri.lendOn, profiles: [], grants: [], requests_in: [], requests_out: [], drivers: [{ agent_id: 'claude', label: 'Claude', support: 'lab', api_key: true, account: true, chat: true, account_note: null }, { agent_id: 'cursor', label: 'Cursor', support: 'no', api_key: false, account: false, chat: false }, ...(tauri.terminalOnly ? [{ agent_id: 'gemini', label: 'Gemini', support: 'lab', api_key: true, account: false, chat: false, account_note: null }] : [])] };
    }
    if (cmd === 'lend_far_offer') {
      if (tauri.offerError) throw tauri.offerError;
      return tauri.offer;
    }
    if (cmd === 'lend_far_note_pane') return null;
    throw new Error('no desktop shell');
  },
}));
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
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  tauri.calls = [];
  tauri.lendOn = true;
  tauri.offerError = null;
  tauri.offer = { offerRef: 'ref-1', profileId: 'lp1', profileName: 'Work Claude', secs: 43200, grantId: null };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
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
const wsl = {
  status: async () => ({ state: 'ready' as const, distros: [] }),
  check: async () => {
    throw new Error('never called');
  },
  placesGet: async () => [],
  placeSet: async () => {
    throw new Error('never called');
  },
  spawnInLinux: async () => 'wsl-pane-1',
} as unknown as WslApi;
const whereOf = (fake: DevicesFake): WhereProps => ({ view: fake.view, api: fake, ssh: new SshFake({ hosts: [BUILD_BOX] }), wsl, onAddDevice: () => {}, onStarted: () => {} });

async function pickMac(fake: DevicesFake) {
  await act(async () => root.render(<NewAgentHost c={fakeApi()} where={whereOf(fake)} project={null} />));
  await settle(6);
  await click(q('[data-testid="na-folder"]'));
  await settle(4);
  await click(q(`[data-testid="na-group-${NODE_MAC}"] .ck-na-item`));
  await settle(10);
}

const openAgentMenu = async () => {
  await click(q('[data-testid="na-agent"]'));
  await settle(2);
};

describe('New agent page: Use my own agents', () => {
  it('ends the far agent list with the section, even though that PC has the same agent, and is not on this PC\'s own page', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await act(async () => root.render(<NewAgentHost c={fakeApi()} where={whereOf(fake)} project={null} />));
    await settle(6);
    await openAgentMenu();
    expect(q('[data-testid="na-my-agents"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await pickMac(fake);
    await openAgentMenu();
    const section = q('[data-testid="na-my-agents"]')!;
    expect(section.querySelector('[data-testid="na-my-agents-head"]')!.textContent).toBe('Use my own agents');
    // This PC's agents with a lend spec only (not Cursor), named as the person reads them.
    expect([...section.querySelectorAll('[role="menuitemradio"] .ck-na-item-row span:last-child')].map((e) => e.textContent)).toEqual(['Claude (my sign-in)']);
    expect(section.textContent).toContain('Your login never leaves this PC');
    // It is after the far PC's own agents.
    const rows = [...document.querySelectorAll('.ck-na-menu [role="menuitemradio"]')];
    expect(rows.map((r) => r.querySelector('.ck-na-item-row span:last-child')!.textContent)).toEqual(['Claude', 'Codex', 'Claude (my sign-in)']);
  });

  it('shows nothing while Lend through my PC is off', async () => {
    tauri.lendOn = false;
    await pickMac(new DevicesFake({ enabled: true, devices: [MAC_MINI] }));
    await openAgentMenu();
    expect(q('[data-testid="na-my-agents"]')).toBeNull();
  });

  it('a pick makes the lend by this PC\'s own click, then starts the far chat on lend:<grant>', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await pickMac(fake);
    await openAgentMenu();
    await click(q('[data-testid="na-my-agents"] [role="menuitemradio"]'));
    // The chip reads the sign-in as this PC's.
    expect(q('[data-testid="na-agent"]')!.textContent).toContain('Claude · My sign-in from Desk-PC');
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Fix the build');
    await click(q('button.ck-na-send'));
    await settle(10);
    // 1. the far PC says it has Claude, 2. this PC writes its own promise, 3. the far PC is asked to ask back, 4. the far start carries the lend.
    const order = [...fake.farCalls.map((c) => `far:${c.cmd}`), ...tauri.calls.filter((c) => c.cmd === 'lend_far_offer').map((c) => `local:${c.cmd}`)];
    expect(order).toContain('local:lend_far_offer');
    expect(tauri.calls.find((c) => c.cmd === 'lend_far_offer')!.args).toEqual({ node: NODE_MAC, agent_id: 'claude' });
    expect(fake.farCalls.find((c) => c.cmd === 'own_borrow_ask')!.args).toEqual({ agentId: 'claude', offerRef: 'ref-1', profileId: 'lp1', secs: 43200 });
    const start = fake.requests.find((r) => r.path === '/pclink/agents/start')!;
    expect(start.body).toMatchObject({ agent: 'claude', lane: 'chat', account: 'lend:lg_far_1' });
    // The far chat is listed on the lend (its chip and Connect name it), by the key this screen keeps.
    const noted = tauri.calls.find((c) => c.cmd === 'lend_far_note_pane')!.args as { grant_id: string; pane_id: string };
    expect(noted.grant_id).toBe('lg_far_1');
    expect(noted.pane_id.startsWith(`dev:${NODE_MAC}:`)).toBe(true);
    // The login never travelled: no far call or start carries anything but the lend's name.
    expect(JSON.stringify(fake.requests)).not.toMatch(/token|secret|sk-/i);
  });

  it('an agent with no lend chat way is offered too, and starts as a terminal on the lend (no chat-only refusal)', async () => {
    tauri.terminalOnly = true;
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.agentsOf[NODE_MAC] = [{ id: 'claude', label: 'Claude' }, { id: 'gemini', label: 'Gemini' }];
    await pickMac(fake);
    await openAgentMenu();
    const mine = [...document.querySelectorAll('[data-testid="na-my-agents"] [role="menuitemradio"]')];
    expect(mine.map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Gemini')]));
    await click(mine.find((r) => r.textContent?.includes('Gemini')) as HTMLElement);
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Go');
    await click(q('button.ck-na-send'));
    await settle(10);
    expect(document.body.textContent).not.toContain('Pick Chat');
    expect(fake.requests.find((r) => r.path === '/pclink/agents/start')!.body).toMatchObject({ agent: 'gemini', lane: 'terminal', account: 'lend:lg_far_1' });
    const noted = tauri.calls.find((c) => c.cmd === 'lend_far_note_pane')!.args as { grant_id: string; pane_id: string };
    expect(noted.grant_id).toBe('lg_far_1');
  });

  it('a lend that already runs for that PC is used again, with no new ask', async () => {
    tauri.offer = { ...tauri.offer, offerRef: '', grantId: 'lg_running' };
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await pickMac(fake);
    await openAgentMenu();
    await click(q('[data-testid="na-my-agents"] [role="menuitemradio"]'));
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Go');
    await click(q('button.ck-na-send'));
    await settle(10);
    expect(fake.farCalls.some((c) => c.cmd === 'own_borrow_ask')).toBe(false);
    expect(fake.requests.find((r) => r.path === '/pclink/agents/start')!.body).toMatchObject({ account: 'lend:lg_running' });
  });

  it('an agent that is not on that PC stops at "Install it on <PC> first" and nothing is lent or started', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    fake.agentsOf[NODE_MAC] = [{ id: 'claude', label: 'Claude', installed: false }, { id: 'codex', label: 'Codex' }];
    await pickMac(fake);
    await openAgentMenu();
    // Still pickable: the far PC does not have Claude, and that is not a reason to hide this PC's.
    await click(q('[data-testid="na-my-agents"] [role="menuitemradio"]'));
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Go');
    await click(q('button.ck-na-send'));
    await settle(10);
    expect(document.body.textContent).toContain('Install Claude on Mac mini first.');
    expect(tauri.calls.some((c) => c.cmd === 'lend_far_offer')).toBe(false);
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
  });

  it('no usable lend sign-in says to sign in for lending first, and starts nothing', async () => {
    tauri.offerError = 'LEND_NO_SIGNIN: Sign in for lending first, then try again.';
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await pickMac(fake);
    await openAgentMenu();
    await click(q('[data-testid="na-my-agents"] [role="menuitemradio"]'));
    await typeInto(q<HTMLTextAreaElement>('textarea.ck-na-input')!, 'Go');
    await click(q('button.ck-na-send'));
    await settle(10);
    expect(document.body.textContent).toContain('Sign in for lending first. Open Connect, then Lending, and add a sign-in for Claude.');
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
  });
});
