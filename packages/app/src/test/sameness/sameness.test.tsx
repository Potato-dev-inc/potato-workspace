// @vitest-environment jsdom
// Sameness guard v1 (DOM half). The same fixture chat is drawn by the real PaneView twice: through the local host, and through the far host
// over a fake PC link client that answers the SAME JSON (it goes through JSON, so a field the far path loses shows). The HTML of the chat
// screen must be identical, except for the one thing that is allowed to differ: the PC's name (the small badge, and the "Runs on" row that
// carries it). A far PC that does not answer a command draws the same tree with that control disabled and the one reason.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import { farChatState } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import { PaneView } from '../../components/cockpit/PaneView';
import { settle } from '../../components/settings/test-utils';
import { farHost } from '../../lib/host/far';
import { HostProvider } from '../../lib/host/context';
import { ALL_CAPS, WATCH_CAPS, type Host } from '../../lib/host/host';
import { placeKey } from '../../lib/host/placeKey';
import type { PcLinkClient } from '../../lib/runtime/pclink';
import { farCockpit } from '../../lib/host/farCockpit';
import { farQuestionsOf } from '../../lib/runtime/farQuestions';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
vi.mock('../../components/TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const NODE = 'a1'.repeat(32);
const NAME = 'Mac mini';
const NOW = 1_700_000_000_000;
const ITEMS = phoneRenderReply(NOW).items;
const STATE = farChatState('p1');

/** What either PC answers for the chat: the same JSON. */
const answer = (cmd: string): unknown => {
  if (cmd === 'acp_chat_state') return STATE;
  if (cmd === 'pane_message_send') return { id: 'm1', text: 'sent', createdAt: NOW, state: 'sent', waitingFor: null, error: null };
  if (cmd === 'session_chat_open') return { available: true, reason: null, source: 'acp', items: ITEMS, waitingFor: null };
  return null;
};
const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;

const localFake: Host = {
  place: { kind: 'local' },
  live: true,
  caps: ALL_CAPS,
  invoke: async <T,>(cmd: string) => wire(answer(cmd)) as T,
  listen: async () => () => undefined,
};

/** Every far call the screen made, in order. */
const sent: { cmd: string; args: unknown }[] = [];
const client = {
  node: NODE,
  call: async (cmd: string, args: unknown) => {
    sent.push({ cmd, args });
    return wire(answer(cmd));
  },
  transcript: async () => wire({ available: true, reason: null, source: 'acp', waitingFor: null, rev: 1, reset: false, items: ITEMS }),
  messages: async () => [],
  interrupt: async () => undefined,
} as unknown as PcLinkClient;
const events = { subscribe: async () => undefined, unsubscribe: async () => undefined, onEvent: async () => () => undefined };

/** A far PC that answers every command (as a same-version PC will once its call table is complete). */
const farAll = farHost(client, events, { name: NAME, caps: ALL_CAPS, calls: { has: () => true } as unknown as ReadonlySet<string> });
/** A far PC of this version, with the real call table (the chat feed and message box rows; the later phases' rows are not there yet). */
const farNow = farHost(client, events, { name: NAME, caps: ALL_CAPS });
/** A far PC of an older version: only the four chat settings rows. */
const farOld = farHost(client, events, { name: NAME, caps: ALL_CAPS, calls: new Set(['acp_chat_state', 'agent_model_options', 'acp_chat_set_config', 'acp_chat_set_force_yes']) });

const info = (id: string, far: boolean): PaneInfo =>
  ({ id, agent_type: 'claude', pid: 0, status: 'idle', created_at: 0, last_output_at: null, cwd: 'app', cols: 80, rows: 24, title: 'Build the .dmg', lane: 'acp', ...(far ? { place: { kind: 'device', distro: NAME, cwd: '', mount_root: '', unc_root: '' } } : {}) }) as PaneInfo;

function cockpit(id: string, far: boolean): CockpitApi {
  const pane = { info: info(id, far), status: 'idle' as const };
  return {
    registry: { paneList: [pane], panes: new Map([[id, pane]]), initialReady: true },
    names: new Map([[id, 'Claude']]),
    asked: { questions: [] },
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: id,
    select: () => undefined,
    interrupt: async () => undefined,
    closePane: async () => undefined,
    rename: async () => undefined,
    prompts: {},
    activities: {},
    previews: {},
    statusSince: new Map(),
    now: NOW,
    spawn: null,
    toasts: [],
    notify: () => undefined,
    bridgeLine: '',
  } as unknown as CockpitApi;
}

let box: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  window.localStorage.clear();
  box = document.createElement('div');
  box.className = 'cockpit';
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(async () => {
  await act(async () => root.unmount());
  box.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/** The chat screen of `host` for pane `id`, as HTML with the key and the PC's name normalised away. */
async function render(host: Host, far: boolean): Promise<{ html: string; dom: HTMLElement }> {
  const id = far ? placeKey(host.place, 'p1') : 'p1';
  await act(async () => root.render(<HostProvider host={host}><PaneView c={cockpit(id, far)} paneId={id} /></HostProvider>));
  await settle(16);
  const dom = box.querySelector<HTMLElement>('.ck-pane')!;
  const copy = dom.cloneNode(true) as HTMLElement;
  // The one allowed hint: the small badge. Its row in the right panel carries the same name.
  copy.querySelectorAll('[data-testid="pane-place"], [data-testid="pane-where"]').forEach((el) => el.remove());
  const html = copy.outerHTML.split(`dev:${NODE}:p1`).join('p1').split(NAME).join('This computer');
  return { html, dom };
}

/** Types into the message box and presses Enter, as a person does. */
async function typeAndSend(dom: HTMLElement, text: string): Promise<void> {
  const box = dom.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the agent"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await settle(8);
}

describe('sameness: the chat screen is the same HTML on this PC and on another PC', () => {
  it('the far PC of this version (the real call table) has a working message box: a message goes out as the pane_message_send row', async () => {
    sent.length = 0;
    const far = await render(farNow, true);
    const box = far.dom.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the agent"]')!;
    expect(box.disabled).toBe(false);
    await typeAndSend(far.dom, 'run the tests again');
    const message = sent.find((c) => c.cmd === 'pane_message_send');
    expect(message?.args).toEqual({ paneId: 'p1', text: 'run the tests again' });
    // Sending is Answer; nothing the screen did claimed a hold.
    expect(JSON.stringify(sent)).not.toContain('"hold"');
  });

  it('a far PC that lets this PC only watch draws the same message box, switched off, and sends nothing', async () => {
    sent.length = 0;
    const watch = farHost(client, events, { name: NAME, caps: WATCH_CAPS });
    const far = await render(watch, true);
    const box = far.dom.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to the agent"]');
    // The same control (or the one reason line in its place), never a message that goes out.
    if (box) expect(box.disabled).toBe(true);
    expect(far.dom.textContent).toContain(`${NAME}`);
    expect(sent.some((c) => c.cmd === 'pane_message_send')).toBe(false);
  });

  it('local host and far host (answering the same JSON) draw identical HTML', async () => {
    const local = await render(localFake, false);
    expect(local.dom.querySelector('[data-testid="session-chat"]')!.textContent).toContain('create a potato workspace overview page');
    await act(async () => root.unmount());
    root = createRoot(box);
    const far = await render(farAll, true);
    expect(far.dom.querySelector('[data-testid="session-chat"]')!.textContent).toContain('create a potato workspace overview page');
    expect(far.html).toBe(local.html);
  });

  it('a far PC of an older version, without the chat feed rows, draws the same tree, with controls disabled, each with the one reason', async () => {
    const local = await render(localFake, false);
    await act(async () => root.unmount());
    root = createRoot(box);
    const far = await render(farOld, true);
    // The same screen (the same chat text and the same controls), but not the same HTML: the controls the far PC cannot answer are disabled.
    expect(far.html).not.toBe(local.html);
    // An old far PC has no chat feed row: the chat says so in the one plain sentence, and every control that needs a row is disabled.
    expect(far.dom.querySelector('[data-testid="session-chat"]')!.textContent).toContain(`Not on ${NAME} yet.`);
    expect(far.dom.querySelectorAll('button[disabled]').length).toBeGreaterThan(local.dom.querySelectorAll('button[disabled]').length);
    const reasons = new Set([...far.dom.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).filter((v) => v?.includes(`Not on ${NAME} yet.`)));
    expect([...reasons]).toEqual([`Not on ${NAME} yet.`]);
    expect(far.dom.textContent).toContain(`Not on ${NAME} yet.`);
  });

  it('P4a: on a far PC of this version Ask aside and Share are the normal controls, switched on', async () => {
    sent.length = 0;
    const far = await render(farNow, true);
    const buttons = [...far.dom.querySelectorAll<HTMLButtonElement>('button')];
    const aside = buttons.find((b) => b.textContent === 'Ask aside')!;
    const share = buttons.find((b) => b.getAttribute('aria-haspopup') === 'menu' && b.textContent === 'Share')!;
    expect(aside.disabled).toBe(false);
    expect(share.disabled).toBe(false);
    expect(aside.title).not.toContain('yet');
    // Share's entries are on (no "Not on <PC> yet" reason on any of them).
    await act(async () => share.click());
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((i) => /Save as/.test(i.textContent ?? '')).every((i) => !i.disabled)).toBe(true);
    await act(async () => share.click());
  });
});

// A far chat's pending tool permission is the same card as a local chat's, never a bare "waiting" line. The far PC's own
// `/pclink/questions` JSON goes through the real parser (`farQuestionsOf`), the real far cockpit and the real PaneView.
describe('sameness: a far chat that waits on a tool permission', () => {
  const RAW_QUESTION = { id: 'q1', pane_id: 'p1', kind: 'acp_permission', question: 'Claude asks permission: Show hostname and OS info', choices: [{ id: 'allow', label: 'Yes' }, { id: 'reject', label: 'No' }], allow_free_text: false, urgency: 'normal', created_at_ms: NOW, expires_at_ms: NOW + 600_000, state: 'pending' };
  const waitingState = farChatState('p1', {
    phase: 'needs_input',
    status: 'waiting_input',
    turnInFlight: true,
    permissions: [{ askId: 1, title: 'Show hostname and OS info', toolKind: 'execute', questionId: 'q1', options: [{ id: 'allow', name: 'Yes', kind: 'allow_once' }, { id: 'reject', name: 'No', kind: 'reject_once' }], sinceMs: NOW }],
  });

  async function renderFar(withQuestion: boolean) {
    const id = placeKey(farAll.place, 'p1');
    const pane = { info: info(id, true), status: 'waiting_input' as const };
    const base = cockpit(id, true);
    const answerFar = vi.fn(async () => undefined);
    const hide = vi.fn();
    const questions = withQuestion ? farQuestionsOf(NODE, NAME, wire([RAW_QUESTION]), () => NOW) : [];
    const c = farCockpit({ ...base, registry: { ...base.registry, paneList: [pane], panes: new Map([[id, pane]]) } } as CockpitApi, client, NAME, [], '', () => undefined, { questions, answer: answerFar, hide });
    const waiting: Host = { ...farAll, invoke: async <T,>(cmd: string, args?: Record<string, unknown>) => (cmd === 'acp_chat_state' ? (wire(waitingState) as T) : farAll.invoke<T>(cmd, args)) };
    await act(async () => root.render(<HostProvider host={waiting}><PaneView c={c} paneId={id} /></HostProvider>));
    await settle(16);
    return { dom: box.querySelector<HTMLElement>('.ck-pane')!, answerFar, hide, id };
  }

  it('shows the permission card with its question, the agent\'s own options and "Don\'t ask again", and Yes answers the far agent', async () => {
    const { dom, answerFar } = await renderFar(true);
    const card = dom.querySelector('[data-testid="decision-card"]')!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Run command');
    expect(card.textContent).toContain('Show hostname and OS info');
    expect(dom.querySelector('[data-testid="decision-never"]')).toBeTruthy();
    expect(dom.textContent).not.toContain("didn't say what for");
    const yes = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Yes')!;
    await act(async () => yes.click());
    // The far PC's own question id, through the far key the Inbox uses too.
    expect(answerFar).toHaveBeenCalledWith(`dev:${NODE}:q1`, { choice_id: 'allow' });
  });

  it('the rail Answer button finds the card (it scrolls to the dock and focuses its first button)', async () => {
    const { dom } = await renderFar(true);
    const go = dom.querySelector<HTMLButtonElement>('[data-testid="rail-needs-you"]')!;
    expect(go).toBeTruthy();
    await act(async () => go.click());
    await settle(4);
    await new Promise((r) => setTimeout(r, 20));
    expect(dom.querySelector('[data-testid="acp-dock"]')!.contains(document.activeElement)).toBe(true);
  });

  it('the far PC\'s Inbox card and this chat card are the same question (same key, so one answer settles both)', async () => {
    const [q] = farQuestionsOf(NODE, NAME, wire([RAW_QUESTION]), () => NOW);
    expect(q.key).toBe(`dev:${NODE}:q1`);
    expect(q).toMatchObject({ paneId: 'p1', kind: 'acp_permission' });
  });
});
