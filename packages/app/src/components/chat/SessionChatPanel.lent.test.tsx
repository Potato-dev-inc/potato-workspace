// @vitest-environment jsdom
// "Probably signed out" under a chat that runs on a sign-in lent by my other PC ("Use my own agents"): the words say whose sign-in it is.
//   Lender's screen: "Your sign-in on this PC ended..." and Sign in opens Connect > Lending (this PC's sign-in), never the agent's "Check my setup" row.
//   The PC that runs the agent: the lender's name, and no Sign in button (there is nothing to sign in on that PC).
//   A chat on its own PC's sign-in: unchanged.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { GRANT_IN_PANE, GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import type { Grant } from '../../lib/lend';
import type { ChatItem } from '../../lib/sessionChatModel';
import { registerConnectOpener } from '../../lib/openConnect';
import { registerSettingsOpener } from '../../lib/openSettingsAt';

let grants: Grant[] = [];
vi.mock('../lend/useLend', () => ({
  useLend: () => ({ state: lendState({ grants }), enabled: true, known: true, now: Date.now(), refresh: () => undefined }),
}));

import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const items: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'please do 1' },
  { kind: 'assistant', id: 'a1', at: null, text: 'ok', model: null, finalAnswer: false },
  { kind: 'notice', id: 'n:ending:x:1', at: null, noticeKind: 'ending:signed_out', text: 'Probably signed out' },
  { kind: 'turnEnd', id: 'end:1', at: null, outcome: 'failed', durationMs: 1000 },
] as ChatItem[];

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const line = () => host.querySelector('[data-testid="turn-ending"]')?.textContent;
const signIn = () => host.querySelector<HTMLButtonElement>('[data-ending-action="sign-in"]');

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'session_chat_open') return { available: true, reason: null, items, source: 'acp' };
    if (cmd === 'pane_messages_list') return [];
    return undefined;
  });
  grants = [];
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  registerConnectOpener(null);
  registerSettingsOpener(null);
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function mount(paneId: string) {
  await act(async () => root.render(<SessionChatPanel paneId={paneId} reply={{ blockedReason: null }} />));
  await flush();
  await flush();
}

describe('signed out under a lent chat', () => {
  it("on the lender's screen it is this PC's sign-in, and Sign in opens Connect > Lending", async () => {
    grants = [{ ...GRANT_OUT, peer_node: 'aa', pane_ids: ['dev:aa:p1'], ends_ms: Date.now() + 3600_000 }];
    const opened = vi.fn();
    registerConnectOpener(opened);
    const settings = vi.fn();
    registerSettingsOpener(settings);
    await mount('dev:aa:p1');
    expect(line()).toBe('Your sign-in on this PC ended. Sign in again, then try again. · Sign in');
    await act(async () => signIn()!.click());
    expect(opened).toHaveBeenCalledWith('lending');
    expect(settings).not.toHaveBeenCalled();
  });

  it("on the PC that runs the agent it names the lender and has no Sign in button", async () => {
    grants = [{ ...GRANT_IN_PANE, peer_node: 'bb', pane_ids: ['p1'], peer_device_name: 'Desk PC', ends_ms: Date.now() + 3600_000 }];
    await mount('p1');
    expect(line()).toBe('The sign-in lent by Desk PC ended. Sign in again on Desk PC, then try again.');
    expect(signIn()).toBeNull();
  });

  it('a lend that ran out still reads as the lent sign-in that ended, not as this PC being signed out', async () => {
    grants = [{ ...GRANT_IN_PANE, peer_node: 'bb', pane_ids: ['p1'], peer_device_name: 'Desk PC', state: 'ended', end_reason: 'expired', ends_ms: Date.now() - 1000 }];
    await mount('p1');
    expect(line()).toBe('The sign-in lent by Desk PC ended. Sign in again on Desk PC, then try again.');
  });

  it("a teammate's lend (no PC of mine) keeps the usual line and Sign in", async () => {
    grants = [{ ...GRANT_IN_PANE, peer_node: undefined, pane_ids: ['p1'], ends_ms: Date.now() + 3600_000 }];
    await mount('p1');
    expect(line()).toBe('Probably signed out · Sign in');
  });

  it("a chat on its own PC's sign-in keeps the usual line and Sign in", async () => {
    await mount('p1');
    expect(line()).toBe('Probably signed out · Sign in');
    expect(signIn()).not.toBeNull();
  });
});
