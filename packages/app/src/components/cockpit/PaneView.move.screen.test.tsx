// @vitest-environment jsdom
// "Move to…" in the chat menu (Devices phase 5), through the real PaneView and the real chat panel. Only the desktop command
// layer is faked: `chat_move_*` is a small copy of the Rust book's rules (the Rust side has its own tests), and the far device
// is the shared `DevicesFake` that records every request it gets.
// Proves: the menu entry (and none while Devices is off), the sheet, the refusal while a reply runs, the lock while moving,
// "Take the conversation" (the far agent's first message holds an early line of the history), "Take the conversation and the
// work" (git only, same agent only, the bundle goes before the chat starts), a signed-out agent there, the old chat read-only
// with `Moved to <device> at HH:MM` and `Open it there`, and a failed move leaving the chat open.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import { OPEN_REMOTE_EVENT } from '../../lib/moveChat';
import type { ChatItem } from '../../lib/sessionChat';
import { PaneView } from './PaneView';

const NEAR_AT = Math.floor(new Date(2026, 10, 15, 14, 20).getTime() / 1000);
const EARLY = 'The code word for this job is mauve-kettle.';
const SAMPLE: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: EARLY },
  { kind: 'assistant', id: 'a1.1', at: null, text: 'Noted.', model: null, finalAnswer: true },
];

const env = vi.hoisted(() => ({ devicesOn: true, listeners: [] as Array<(e: { payload: string }) => void> }));
vi.mock('../../lib/devices', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/devices')>()), useDevicesEnabled: () => env.devicesOn }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: string }) => void) => {
    if (name === 'chat-move://changed') env.listeners.push(cb);
    return () => undefined;
  }),
  emit: vi.fn(async () => undefined),
}));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));
vi.mock('../../lib/sessionChat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/sessionChat')>()),
  openSessionChat: vi.fn(async () => ({ available: true, reason: null, source: 'acp', items: SAMPLE })),
  closeSessionChat: vi.fn(async () => undefined),
  onSessionChatItems: vi.fn(async () => () => undefined),
  onSessionChatStatus: vi.fn(async () => () => undefined),
  onSessionChatSource: vi.fn(async () => () => undefined),
}));

// A small copy of the Rust book (`chat_move/mod.rs`): the same refusals, in the same words.
const book = {
  entry: null as null | { state: 'moving'; mode: string } | { state: 'moved'; node: string; device: string; far_pane: string; at: number; mode: string },
  running: false,
  notGit: false,
  holdHistory: null as null | Promise<void>,
  calls: [] as string[],
};
/** What Rust does after a change: tells the window (`chat-move://changed`). */
const changed = () => env.listeners.forEach((cb) => cb({ payload: 'p1' }));
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd.startsWith('chat_move_')) book.calls.push(cmd);
  switch (cmd) {
    case 'chat_move_status':
      return book.entry ?? { state: 'none' };
    case 'chat_move_begin':
      if (book.entry?.state === 'moved') throw 'This chat has moved to another device. Open it there to carry on.';
      if (book.running) throw 'Wait for the reply to finish, or stop it.';
      if (args?.mode === 'work' && book.notGit) throw 'This folder is not a git project, so the work cannot move. You can still take the conversation.';
      book.entry = { state: 'moving', mode: String(args?.mode) };
      changed();
      return { agentType: 'claude', agentLabel: 'Claude' };
    case 'chat_move_history':
      await book.holdHistory;
      return { text: `This conversation was moved to you from Claude on ${String(args?.fromDevice)}. Read it first.\n--- conversation so far ---\n${EARLY}\n--- end ---` };
    case 'chat_move_prepare_work':
      return { branch: 'potato/move-abc123def0', sha: 'f'.repeat(40), bundleB64: 'QlVORExF', size: 6 };
    case 'chat_move_finish':
      book.entry = { state: 'moved', node: String(args?.node), device: String(args?.device), far_pane: String(args?.farPane), at: NEAR_AT, mode: book.entry && book.entry.state === 'moving' ? book.entry.mode : 'history' };
      changed();
      return null;
    case 'chat_move_abort':
      if (book.entry?.state === 'moving') book.entry = null;
      changed();
      return null;
    default:
      return cmd === 'checkpoints_list' ? { state: 'ok', message: '', items: [] } : null;
  }
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));

let fake: DevicesFake;
const devicesMock = (cmd: string, args?: Record<string, unknown>): Promise<unknown> | undefined => {
  if (cmd === 'devices_state') return Promise.resolve(fake.view);
  if (cmd === 'devices_request') return fake.request(String(args?.node), String(args?.method), String(args?.path), args?.body);
  if (cmd.startsWith('devices_')) return Promise.resolve(null);
  return undefined;
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

function cockpit(status: 'idle' | 'running' = 'idle') {
  const info = { id: 'p1', agent_type: 'claude', status, pid: 0, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 100, rows: 30, lane: 'acp' };
  const p = { status, info };
  return {
    registry: { paneList: [p], panes: new Map([['p1', p]]), initialReady: true },
    names: new Map([['p1', 'Claude']]),
    activities: {},
    previews: {},
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    prompts: {},
    statusSince: new Map(),
    now: 12_000,
    selectedId: 'p1',
    mode: 'orchestration',
    select: vi.fn(),
    notify: vi.fn(),
    answer: vi.fn(),
    closePane: vi.fn(),
  } as unknown as CockpitApi;
}

const acpState = (turnInFlight = false): AcpChatState =>
  ({
    lane: 'acp', agent: 'claude', label: 'Claude', phase: turnInFlight ? 'working' : 'idle', status: turnInFlight ? 'running' : 'idle', turnInFlight, stopping: false, canSteer: false, turn: 1, title: null,
    usage: null, permissions: [], closed: false, conversation: 'p1', inTerminal: null, agentAnswering: false, configOptions: [], commands: [],
  }) as AcpChatState;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  env.devicesOn = true;
  book.entry = null;
  book.running = false;
  book.notGit = false;
  book.holdHistory = null;
  book.calls = [];
  env.listeners = [];
  fake = new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [{ ...MAC_MINI, lets_run: true }, WORK_LAPTOP] });
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    const far = devicesMock(cmd, args);
    return far !== undefined ? far : base(cmd, args);
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const flush = async (n = 4) => {
  for (let i = 0; i < n; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const q = <T extends Element = HTMLElement>(sel: string) => host.ownerDocument.querySelector<T>(sel);
const tid = (id: string) => q<HTMLElement>(`[data-testid="${id}"]`);
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
const clickEl = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
};

async function mount(running = false) {
  const c = cockpit(running ? 'running' : 'idle');
  await act(async () => root.render(<PaneView c={c} paneId="p1" acp={fakeAcpApi({ state: async () => acpState(running) })} />));
  await flush(6);
}

async function openSheet() {
  await clickEl(q('button[aria-haspopup="menu"][aria-label="Save or share this chat"], button[aria-label="Chat menu"]'));
  await clickEl(tid('chat-menu-move'));
  await flush();
}

async function pickMac() {
  await clickEl(tid(`move-device-${NODE_MAC}`)!.querySelector('input'));
  await flush(6);
}

describe('Move to… in the chat menu', () => {
  it('is in the chat menu, and absent while Devices is off', async () => {
    await mount();
    await clickEl(q('button[aria-haspopup="menu"][aria-label="Save or share this chat"], button[aria-label="Chat menu"]'));
    expect(tid('chat-menu-move')?.textContent).toBe('Move to…');
    await act(async () => root.unmount());
    root = createRoot(host);
    env.devicesOn = false;
    await mount();
    await clickEl(q('button[aria-haspopup="menu"][aria-label="Save or share this chat"], button[aria-label="Chat menu"]'));
    expect(tid('chat-menu-move')).toBeNull();
  });

  it('lists the paired devices; one that is offline cannot be picked and says why', async () => {
    await mount();
    await openSheet();
    const mac = tid(`move-device-${NODE_MAC}`)!;
    const laptop = tid(`move-device-${WORK_LAPTOP.node}`)!;
    expect(mac.querySelector('input')!.disabled).toBe(false);
    expect(laptop.querySelector('input')!.disabled).toBe(true);
    expect(laptop.textContent).toContain('Work laptop');
    expect(laptop.textContent).toMatch(/offline|not answering|Off|asleep/i);
  });

  it('is refused while a reply runs, with the plain sentence, and nothing is locked', async () => {
    await mount(true);
    await openSheet();
    expect(tid('move-running')?.textContent).toBe('Wait for the reply to finish, or stop it.');
    await pickMac();
    expect((tid('move-go') as HTMLButtonElement).disabled).toBe(true);
    expect(book.calls).not.toContain('chat_move_begin');
  });

  it('if the desktop refuses the lock, the sentence shows and the far device is not touched', async () => {
    await mount();
    await openSheet();
    await pickMac();
    book.running = true; // the reply started after the sheet opened
    await clickEl(tid('move-go'));
    expect(tid('move-error')?.textContent).toBe('Wait for the reply to finish, or stop it.');
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('Take the conversation', () => {
  it('the far agent gets the history as its first message, the old chat becomes read-only with a note, and Open it there works', async () => {
    await mount();
    await openSheet();
    await pickMac();
    expect(tid('move-go') && (tid('move-go') as HTMLButtonElement).disabled).toBe(false);
    const opened: Array<{ node: string; paneId: string }> = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_REMOTE_EVENT, onOpen);
    await clickEl(tid('move-go'));
    window.removeEventListener(OPEN_REMOTE_EVENT, onOpen);

    // The far chat started in the far project, and the first message holds an early line of the history.
    const start = fake.requests.find((r) => r.path === '/pclink/agents/start')!;
    expect(start.body).toMatchObject({ agent: 'claude', project: 'proj-app', lane: 'chat' });
    const first = fake.requests.find((r) => /^\/pclink\/sessions\/[^/]+\/messages/.test(r.path) && r.method === 'POST')!;
    const text = (first.body as { text: string }).text;
    expect(text).toContain(EARLY);
    expect(text).toContain('moved to you from Claude on Desk-PC');
    // No work went along, and nothing like a sign-in.
    expect(fake.requests.some((r) => r.path === '/pclink/move-work')).toBe(false);
    expect(JSON.stringify(fake.requests)).not.toMatch(/token|password|secret/i);
    // The cockpit is asked to open the far chat.
    expect(opened).toEqual([{ node: NODE_MAC, paneId: 'n1' }]);

    // The old chat: read-only, with the note.
    const note = tid('moved-note')!;
    expect(note.textContent).toContain('Moved to Mac mini at 14:20');
    expect(host.textContent).toContain('This chat moved to Mac mini. Open it there to carry on.');
    const reopened: Array<{ node: string; paneId: string }> = [];
    const onAgain = (e: Event) => reopened.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_REMOTE_EVENT, onAgain);
    await clickEl(tid('moved-open'));
    window.removeEventListener(OPEN_REMOTE_EVENT, onAgain);
    expect(reopened).toEqual([{ node: NODE_MAC, paneId: 'n1' }]);
    // It cannot be moved again.
    await clickEl(q('button[aria-haspopup="menu"][aria-label="Save or share this chat"], button[aria-label="Chat menu"]'));
    expect(tid('chat-menu-move')).toBeNull();
  });

  it('the chat is locked while it moves (the message box says so) and opens again when the move fails', async () => {
    await mount();
    await openSheet();
    await pickMac();
    let release!: () => void;
    book.holdHistory = new Promise<void>((r) => (release = r));
    await clickEl(tid('move-go'));
    expect(book.entry).toMatchObject({ state: 'moving' });
    // The sheet shows it is working, and the chat's own box is switched off with the lock sentence.
    expect(tid('move-go')!.textContent).toBe('Moving…');
    expect(host.textContent).toContain('This chat is moving. Wait a moment.');
    // The far device refuses to start the chat: the whole move is undone.
    fake.request = async () => ({ status: 403, body: { error: 'not_allowed' } });
    await act(async () => release());
    await flush(6);
    expect(tid('move-error')).toBeTruthy();
    expect(book.entry).toBeNull();
    expect(book.calls).toContain('chat_move_abort');
    expect(host.textContent).not.toContain('This chat is moving');
    expect(tid('moved-note')).toBeNull();
  });

  it('a signed-out agent there says so and asks for a sign-in on that device first', async () => {
    fake.setDevice(NODE_MAC, { signed_out: ['claude'] });
    await mount();
    await openSheet();
    await pickMac();
    const why = tid('move-why')!.textContent!;
    expect(why).toContain('Claude is signed out on Mac mini.');
    expect(why).toContain('Sign in on Mac mini. Sign-ins stay on their own device.');
    expect((tid('move-go') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Take the conversation and the work', () => {
  const chooseWork = async () => clickEl([...document.querySelectorAll<HTMLInputElement>('input[name="move-way"]')][1]);

  it('sends the bundle to the far project first, then starts the same agent there on it', async () => {
    await mount();
    await openSheet();
    await pickMac();
    await chooseWork();
    await clickEl(tid('move-go'));
    const order = fake.requests.filter((r) => r.method === 'POST').map((r) => r.path);
    expect(order.slice(0, 2)).toEqual(['/pclink/move-work', '/pclink/agents/start']);
    const sent = fake.requests.find((r) => r.path === '/pclink/move-work')!.body as { project: string; branch: string; bundle_b64: string };
    expect(sent).toEqual({ project: 'proj-app', branch: 'potato/move-abc123def0', bundle_b64: 'QlVORExF' });
    expect(fake.requests.find((r) => r.path === '/pclink/agents/start')!.body).toMatchObject({ agent: 'claude' });
    expect(tid('moved-note')).toBeTruthy();
  });

  it('a folder that is not a git project is refused in plain words before anything is sent', async () => {
    book.notGit = true;
    await mount();
    await openSheet();
    await pickMac();
    await chooseWork();
    await clickEl(tid('move-go'));
    expect(tid('move-error')?.textContent).toBe('This folder is not a git project, so the work cannot move. You can still take the conversation.');
    expect(fake.requests.filter((r) => r.method === 'POST')).toHaveLength(0);
    expect(book.entry).toBeNull();
  });

  it('is off when the far device does not have the same agent', async () => {
    const orig = fake.request;
    fake.request = async (node, method, path, body) =>
      path === '/pclink/agents' ? { status: 200, body: { agents: [{ id: 'codex', label: 'Codex', chat: true, terminal: true }], terminals: true } } : orig(node, method, path, body);
    await mount();
    await openSheet();
    await pickMac();
    const work = [...document.querySelectorAll<HTMLInputElement>('input[name="move-way"]')][1];
    expect(work.disabled).toBe(true);
    expect(document.body.textContent).toContain('The work only moves to the same agent (Claude).');
    // The conversation alone still goes, to the agent that is there.
    expect((tid('move-agent') as HTMLSelectElement).value).toBe('codex');
    expect((tid('move-go') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a far folder with unsaved changes refuses and the chat stays open here', async () => {
    const orig = fake.request;
    fake.request = async (node, method, path, body) =>
      path === '/pclink/move-work' ? { status: 409, body: { code: 'MOVE_REFUSED', error: 'That folder on the other device has changes that are not saved. Save or put them aside there first.' } } : orig(node, method, path, body);
    await mount();
    await openSheet();
    await pickMac();
    await chooseWork();
    await clickEl(tid('move-go'));
    expect(tid('move-error')?.textContent).toContain('has changes that are not saved');
    expect(book.entry).toBeNull();
    expect(fake.requests.some((r) => r.path === '/pclink/agents/start')).toBe(false);
  });
});
