// @vitest-environment jsdom
// The "+" menu as a whole screen: the real Sidebar, the real menu, the real "no chat yet" prompt, the real add-chat dialog and
// the real typed API layers (agent lanes, add-ons, overlay resolve). Only the desktop shell (`invoke`) is a mock, and it answers
// in the JSON shape the Rust commands send. Covers: Chat is the default; the switch is saved and comes back; a ready agent
// starts a chat; a shell always starts a terminal; an agent with no chat gets the right buttons (add-on, adapter, add chat,
// neither); install then start; Use terminal; a failed install keeps the choices; Chat switched off in Labs.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import type { StartMode, StartModeApi } from '../../lib/newAgentStart';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
// The event fake: `emitAddon` delivers an `acp-addon-changed` event to every listener, like the desktop shell does.
type AddonListener = (e: { payload: unknown }) => void;
const addonListeners = new Set<AddonListener>();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, cb: AddonListener) => {
    addonListeners.add(cb);
    return () => {
      addonListeners.delete(cb);
    };
  },
}));
const emitAddon = (status: { agent: string }) => {
  for (const cb of [...addonListeners]) cb({ payload: { agent: status.agent, status } });
};

// ---- what the desktop app sends ---------------------------------------------------------------------------------------

const readyRow = { id: 'readyagent', label: 'Ready agent', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null };
const addonRow = { id: 'addonagent', label: 'Addon agent', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null };
const laneView = (over: Record<string, unknown> = {}) => ({
  labs_enabled: true,
  agents: [readyRow, addonRow],
  can_add_chat: [{ id: 'nochat', label: 'No chat agent' }],
  terminal_chat: [],
  ...over,
});
const addonStatus = (over: Record<string, unknown> = {}) => ({
  agent: 'addonagent',
  label: 'Addon agent',
  state: 'not_installed',
  version: null,
  pinned_version: '1.0.0',
  detail: '',
  size_mb: 17,
  lines: [],
  signin_hint: '',
  ...over,
});
const nativeOption = (available: boolean) => ({ kind: 'native', label: 'On this computer', summary: 'The program starts chat itself.', command_line: 'x acp', acp: { command: 'x', args: ['acp'], env_allow: [] }, available, ...(available ? {} : { reason: 'No chat command in its help.' }) });
const adapterOption = (available: boolean) => ({
  kind: 'adapter',
  label: 'Reviewed adapter',
  summary: 'Potato Workspace runs a reviewed adapter.',
  available,
  adapter: { id: 'fakeagent', tested_version: '1.0.0' },
  env_keys: [],
  env_settings: [],
  key_groups: [],
  installed_version: '1.0.0',
  ...(available ? {} : { reason: 'No adapter for it.' }),
});
const bridgeOption = (available: boolean) => ({ kind: 'bridge', label: 'Chat made by Potato Workspace', summary: 'Potato Workspace makes a chat.', ...(available ? { bridge: { has_memory: false } } : { reason: 'It has no one-message mode.' }), available });

interface Shell {
  lanes: Record<string, unknown>;
  options: unknown[];
  addons: Record<string, unknown>[];
  chatStart: (args: { agentId: string }) => unknown;
  addonInstall: (agent: string) => unknown;
}
let shell: Shell;

function answer(command: string, args: Record<string, unknown> | undefined): unknown {
  switch (command) {
    case 'agent_lane_get':
      return shell.lanes;
    case 'acp_overlay_resolve':
      return { ok: true, options: shell.options };
    case 'acp_addon_status':
      return { labs_enabled: true, addons: shell.addons };
    case 'acp_addon_install':
      return shell.addonInstall(String(args?.agentId));
    case 'acp_chat_start':
      return shell.chatStart(args as { agentId: string });
    case 'acp_adapter_key_status':
      return [];
    case 'acp_overlay_install':
      return { id: args?.agent, label: 'No chat agent', lane: 'terminal', effective_lane: 'acp', disabled: false, disabled_note: null, overlay: true };
    default:
      throw new Error(`unmocked command ${command}`);
  }
}
const calls = (command: string) => invoke.mock.calls.filter((c) => c[0] === command).map((c) => c[1] as Record<string, unknown>);

// ---- the screen -------------------------------------------------------------------------------------------------------

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
    chatStarting: null,
    beginChatStart: vi.fn(),
    endChatStart: vi.fn(),
    toasts: [],
    notify: vi.fn(),
    newAgent: vi.fn(async () => {}),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi & { newAgent: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
}

const ship = {
  recent: vi.fn().mockResolvedValue([{ path: 'C:\\work\\proj', name: 'proj', state: 'repo', last_used_ms: 1 }]),
  gitState: vi.fn().mockResolvedValue('repo'),
} as unknown as ShipApi;

/** A saved setting that outlives a mount, like the settings file does. */
function savedMode(initial?: StartMode) {
  let value = initial;
  const set = vi.fn(async (m: StartMode) => {
    value = m;
  });
  const api: StartModeApi = { get: async () => value ?? 'chat', set };
  return { api, set, value: () => value };
}

let host: HTMLDivElement;
let root: Root;
let c: ReturnType<typeof cockpit>;

beforeEach(() => {
  invoke.mockReset();
  addonListeners.clear();
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => answer(command, args));
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
  shell = {
    lanes: laneView(),
    options: [],
    addons: [addonStatus()],
    chatStart: (a) => ({ pane_id: `chat-${a.agentId}`, agent: a.agentId, lane: 'acp' }),
    addonInstall: () => addonStatus({ state: 'installed', version: '1.0.0' }),
  };
  c = cockpit();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

async function mount(modeApi: StartModeApi = savedMode().api) {
  await act(async () => root.render(<Sidebar c={c} onOpenPalette={() => {}} ship={ship} startModeApi={modeApi} />));
  await act(async () => {});
}
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => {});
};
async function openMenu() {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New agent"]')!.click());
  await settle();
  return host.querySelector<HTMLElement>('[role="menu"]')!;
}
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const row = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('button.ck-menu-item')].find((b) => b.textContent?.includes(label))!;
const seg = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>('[data-testid="start-mode"] .ck-lane-seg-btn')].find((b) => b.textContent === label)!;
const button = (label: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label));
const click = async (el: Element | undefined | null) => {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const prompt = (id: string) => host.querySelector<HTMLElement>(`[data-testid="nochat-${id}"]`);
const promptButtons = (id: string) => [...prompt(id)!.querySelectorAll('button')].map((b) => b.textContent);

describe('the New agent menu: one Chat | Terminal switch', () => {
  it('starts on Chat for a person who never chose, with the switch once at the top and none on a row', async () => {
    await mount();
    await openMenu();
    expect(seg('Chat').getAttribute('aria-pressed')).toBe('true');
    expect(seg('Terminal').getAttribute('aria-pressed')).toBe('false');
    expect(menu()!.querySelectorAll('.ck-lane-seg')).toHaveLength(1);
    expect(menu()!.querySelector('[data-testid^="lane-row-"]')).toBeNull();
    // The old per-row words are gone from the menu.
    expect(menu()!.textContent).not.toContain('Chat (terminal)');
  });

  it('saves the choice and shows it again in a new mount of the app', async () => {
    const saved = savedMode();
    await mount(saved.api);
    await openMenu();
    await click(seg('Terminal'));
    expect(saved.set).toHaveBeenCalledWith('terminal');
    expect(seg('Terminal').getAttribute('aria-pressed')).toBe('true');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(saved.api);
    await openMenu();
    expect(seg('Terminal').getAttribute('aria-pressed')).toBe('true');
    expect(seg('Chat').getAttribute('aria-pressed')).toBe('false');
  });

  it('on Chat, a ready agent starts a chat in the menu\'s folder, opens it and closes the menu', async () => {
    await mount();
    await openMenu();
    await click(row('Ready agent'));
    expect(calls('acp_chat_start')).toEqual([{ agentId: 'readyagent', folder: 'C:\\work\\proj', explicit: true }]);
    expect(c.select).toHaveBeenCalledWith('chat-readyagent');
    expect(c.newAgent).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('on Terminal, the same agent starts a terminal and no chat', async () => {
    await mount();
    await openMenu();
    await click(seg('Terminal'));
    await click(row('Ready agent'));
    expect(calls('acp_chat_start')).toHaveLength(0);
    expect(c.newAgent).toHaveBeenCalledTimes(1);
    expect((c.newAgent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('readyagent');
  });

  it('a shell row always opens a terminal, with no chat text and no chat button, on Chat too', async () => {
    shell.lanes = laneView({ can_add_chat: [{ id: 'powershell', label: 'PowerShell' }, { id: 'nochat', label: 'No chat agent' }] });
    await mount();
    await openMenu();
    expect(seg('Chat').getAttribute('aria-pressed')).toBe('true');
    expect(menu()!.querySelector('[aria-label="Set up chat for PowerShell"]')).toBeNull();
    await click(row('PowerShell'));
    expect(calls('acp_chat_start')).toHaveLength(0);
    expect(calls('acp_overlay_resolve')).toHaveLength(0);
    expect((c.newAgent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('powershell');
    expect(host.querySelector('[data-testid="nochat-powershell"]')).toBeNull();
  });

  it('with Chat switched off in Labs the menu has no switch and starts terminals only', async () => {
    shell.lanes = laneView({ labs_enabled: false });
    await mount();
    await openMenu();
    expect(menu()!.querySelector('[data-testid="start-mode"]')).toBeNull();
    expect(menu()!.querySelector('.ck-lane-seg')).toBeNull();
    expect(menu()!.querySelector('.ck-menu-setup')).toBeNull();
    await click(row('Ready agent'));
    expect(calls('acp_chat_start')).toHaveLength(0);
    expect((c.newAgent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('readyagent');
  });
});

describe('the New agent menu: an agent with no working chat yet', () => {
  it('the add-on is missing: one small prompt with the install button, the size and Use terminal, no long text', async () => {
    shell.chatStart = () => Promise.reject('ACP_ADDON_MISSING: Chat needs a small add-on for Addon agent (about 17 MB). Install it in Settings.');
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    expect(menu()).not.toBeNull();
    expect(promptButtons('addonagent')).toEqual(['Install chat add-on (17 MB)', 'Use terminal']);
    expect(menu()!.textContent).not.toContain('You can install it in Settings');
    expect(menu()!.textContent).not.toContain('Chat needs a small add-on');
    expect(menu()!.querySelector('[data-testid="chat-start-failed"]')).toBeNull();
    expect(calls('acp_overlay_resolve')).toHaveLength(0);
  });

  it('install then start: shows progress, runs the same install as Settings, then starts the chat', async () => {
    shell.chatStart = vi.fn().mockRejectedValueOnce('ACP_ADDON_MISSING: needs the add-on').mockImplementation((a: { agentId: string }) => ({ pane_id: `chat-${a.agentId}`, agent: a.agentId, lane: 'acp' }));
    let finish!: (status: unknown) => void;
    shell.addonInstall = () => new Promise((resolve) => (finish = resolve));
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    await click(button('Install chat add-on', prompt('addonagent')!));
    expect(prompt('addonagent')!.textContent).toContain('Installing…');
    expect(calls('acp_addon_install')).toEqual([{ agentId: 'addonagent' }]);
    expect(button('Install chat add-on', prompt('addonagent')!)!.disabled).toBe(true);
    await act(async () => finish(addonStatus({ state: 'installed', version: '1.0.0' })));
    await settle();
    expect(calls('acp_chat_start')).toEqual([
      { agentId: 'addonagent', folder: 'C:\\work\\proj', explicit: true },
      { agentId: 'addonagent', folder: 'C:\\work\\proj', explicit: true },
    ]);
    expect(c.select).toHaveBeenCalledWith('chat-addonagent');
    expect(menu()).toBeNull();
  });

  // The real backend: `acp_addon_install` returns at once with `installing`; the end comes later as an event or in the list.
  it('install returns installing, then the event says installed: no alert, and the chat starts', async () => {
    shell.chatStart = vi.fn().mockRejectedValueOnce('ACP_ADDON_MISSING: needs the add-on').mockImplementation((a: { agentId: string }) => ({ pane_id: `chat-${a.agentId}`, agent: a.agentId, lane: 'acp' }));
    shell.addonInstall = () => addonStatus({ state: 'installing', lines: ['Downloading'] });
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    await click(button('Install chat add-on', prompt('addonagent')!));
    expect(prompt('addonagent')!.textContent).toContain('Installing…');
    expect(calls('acp_chat_start')).toHaveLength(1);
    await act(async () => emitAddon(addonStatus({ state: 'installed', version: '1.0.0' })));
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(calls('acp_chat_start')).toHaveLength(2);
    expect(c.select).toHaveBeenCalledWith('chat-addonagent');
    expect(menu()).toBeNull();
  });

  it('install returns installing, then the event says failed: the alert has the first sentence and the choices stay', async () => {
    shell.chatStart = () => Promise.reject('ACP_ADDON_MISSING: needs the add-on');
    shell.addonInstall = () => addonStatus({ state: 'installing', lines: [] });
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    await click(button('Install chat add-on', prompt('addonagent')!));
    await act(async () => emitAddon(addonStatus({ state: 'failed', detail: 'The download did not finish. Check the connection and try again.' })));
    await settle();
    expect(prompt('addonagent')!.querySelector('[role="alert"]')!.textContent).toBe('The download did not finish.');
    expect(promptButtons('addonagent')).toEqual(['Install chat add-on (17 MB)', 'Use terminal']);
    expect(button('Install chat add-on', prompt('addonagent')!)!.disabled).toBe(false);
    expect(calls('acp_chat_start')).toHaveLength(1);
    expect(c.select).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('install returns installing and no event comes: the list says installed a little later, and the chat starts', async () => {
    shell.chatStart = vi.fn().mockRejectedValueOnce('ACP_ADDON_MISSING: needs the add-on').mockImplementation((a: { agentId: string }) => ({ pane_id: `chat-${a.agentId}`, agent: a.agentId, lane: 'acp' }));
    shell.addonInstall = () => addonStatus({ state: 'installing', lines: [] });
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    // The list is read every 2 seconds, so the installed state shows there before any event.
    shell.addons = [addonStatus({ state: 'installed', version: '1.0.0' })];
    await click(button('Install chat add-on', prompt('addonagent')!));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2200));
    });
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(calls('acp_chat_start')).toHaveLength(2);
    expect(c.select).toHaveBeenCalledWith('chat-addonagent');
    expect(menu()).toBeNull();
  });

  it('a failed install says why in a few words and keeps every choice', async () => {
    shell.chatStart = () => Promise.reject('ACP_ADDON_MISSING: needs the add-on');
    shell.addonInstall = () => addonStatus({ state: 'failed', detail: 'The download did not finish. Check the connection and try again.' });
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    await click(button('Install chat add-on', prompt('addonagent')!));
    const note = prompt('addonagent')!.querySelector('[role="alert"]')!;
    expect(note.textContent).toBe('The download did not finish.');
    expect(promptButtons('addonagent')).toEqual(['Install chat add-on (17 MB)', 'Use terminal']);
    expect(button('Install chat add-on', prompt('addonagent')!)!.disabled).toBe(false);
    expect(menu()).not.toBeNull();
    expect(c.newAgent).not.toHaveBeenCalled();
  });

  it('an install that the shell refuses also keeps the choices', async () => {
    shell.chatStart = () => Promise.reject('ACP_ADDON_MISSING: needs the add-on');
    shell.addonInstall = () => Promise.reject('ACP_ADDON_FAILED: No space left on the disk. Free some space.');
    await mount();
    await openMenu();
    await click(row('Addon agent'));
    await click(button('Install chat add-on', prompt('addonagent')!));
    expect(prompt('addonagent')!.querySelector('[role="alert"]')!.textContent).toBe('No space left on the disk.');
    expect(promptButtons('addonagent')).toContain('Use terminal');
  });

  it('no chat at all and an adapter on offer: Use adapter, Add chat… for the other ways, and Use terminal', async () => {
    shell.options = [adapterOption(true), nativeOption(true), bridgeOption(false)];
    await mount();
    await openMenu();
    await click(row('No chat agent'));
    expect(calls('acp_overlay_resolve')).toEqual([{ agent: 'nochat' }]);
    expect(promptButtons('nochat')).toEqual(['Use adapter', 'Add chat…', 'Use terminal']);
    // drawn with the shared empty state: one button, the other ways as quiet rows
    expect(prompt('nochat')!.querySelector('[data-empty-state] .ck-btn--primary')!.textContent).toBe('Use adapter');
    expect(prompt('nochat')!.querySelectorAll('.ck-empty-or li')).toHaveLength(2);
    expect(calls('acp_chat_start')).toHaveLength(0);
    expect(c.newAgent).not.toHaveBeenCalled();
  });

  it('only an adapter on offer: no Add chat…', async () => {
    shell.options = [adapterOption(true), nativeOption(false), bridgeOption(false)];
    await mount();
    await openMenu();
    await click(row('No chat agent'));
    expect(promptButtons('nochat')).toEqual(['Use adapter', 'Use terminal']);
  });

  it('only other ways on offer: Add chat… and Use terminal, no adapter button', async () => {
    shell.options = [adapterOption(false), nativeOption(true)];
    await mount();
    await openMenu();
    await click(row('No chat agent'));
    expect(promptButtons('nochat')).toEqual(['Add chat…', 'Use terminal']);
  });

  it('nothing on offer: just Use terminal, and it starts that agent in a terminal once', async () => {
    shell.options = [adapterOption(false), nativeOption(false), bridgeOption(false)];
    await mount();
    await openMenu();
    await click(row('No chat agent'));
    expect(promptButtons('nochat')).toEqual(['Use terminal']);
    expect(menu()!.textContent).not.toContain('Settings');
    await click(button('Use terminal', prompt('nochat')!));
    expect(calls('acp_chat_start')).toHaveLength(0);
    expect(c.newAgent).toHaveBeenCalledTimes(1);
    expect((c.newAgent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('nochat');
    expect(menu()).toBeNull();
    // Once: the switch is still on Chat for the next time.
    await openMenu();
    expect(seg('Chat').getAttribute('aria-pressed')).toBe('true');
  });

  it('Use adapter opens the add-chat dialog on the adapter way, and the chat starts once it is added', async () => {
    shell.options = [nativeOption(true), adapterOption(true)];
    await mount();
    await openMenu();
    await click(row('No chat agent'));
    await click(button('Use adapter', prompt('nochat')!));
    expect(menu()).toBeNull();
    const dialog = document.querySelector('[data-testid="add-chat-dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector<HTMLInputElement>('[data-testid="add-chat-option-adapter"] input[type="radio"]')?.checked).toBe(true);
    await click(button('Add chat', dialog));
    expect(calls('acp_overlay_install')).toEqual([{ agent: 'nochat', option: { kind: 'adapter', approved_keys: [], settings: {} }, confirmed: true }]);
    expect(calls('acp_chat_start')).toEqual([{ agentId: 'nochat', folder: 'C:\\work\\proj', explicit: true }]);
    expect(c.select).toHaveBeenCalledWith('chat-nochat');
  });

  it('"Set up chat for another agent…" lists the agents with no chat, and a pick opens the add-chat dialog', async () => {
    shell.options = [adapterOption(true)];
    await mount();
    await openMenu();
    // No per-row button any more: the one link under the list is the way in.
    expect(menu()!.querySelector('[aria-label="Set up chat for No chat agent"]')).toBeNull();
    const link = () => [...menu()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Set up chat for another agent…');
    await click(link());
    // The pick list item (the agent's own row also reads "No chat agent", so the test id tells them apart).
    await click(menu()!.querySelector('[data-testid="add-pick-nochat"]'));
    expect(document.querySelector('[data-testid="add-chat-dialog"]')).not.toBeNull();
  });
});
