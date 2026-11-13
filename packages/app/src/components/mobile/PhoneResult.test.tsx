// @vitest-environment jsdom
// P10 on the phone: when a turn ends the chat ends with one result card (a two-line summary, the files with +/-, the tests line).
// Tap it and it opens full screen with the file list and the diff. Ask to fix fills the box and sends nothing; Keep hides the card;
// Share hands the text over. Where the PC has no summary, the card shows only the files the chat shows and "Read all".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { BridgeClient } from '../../lib/bridge-types';
import type { ChatItem, PhoneChatReply } from '../../lib/sessionChatModel';
import type { PaneResult } from '../../lib/phone-upload';
import { PhoneChatView } from './PhoneChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const ITEMS: ChatItem[] = [
  { kind: 'user', id: '1:0', at: null, text: 'Fix the login redirect' },
  { kind: 'toolCall', id: '2:0', at: null, callId: 'c1', name: 'Edit', summary: 'src/auth/redirect.ts', paths: ['src/auth/redirect.ts'], writes: true },
  { kind: 'toolResult', id: '3:0', at: null, callId: 'c1', ok: true, output: '' },
  { kind: 'toolCall', id: '4:0', at: null, callId: 'c2', name: 'Edit', summary: 'src/auth/session.ts', paths: ['src/auth/session.ts'], writes: true },
  { kind: 'toolResult', id: '5:0', at: null, callId: 'c2', ok: true, output: '' },
  { kind: 'assistant', id: '6:0', at: null, text: 'The redirect keeps the page you came from. Session code now stores it.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: '7:0', at: null, outcome: 'completed', durationMs: 240_000 },
];
const chat = (items: ChatItem[] = ITEMS): PhoneChatReply => ({ available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items });

const RESULT: PaneResult = {
  available: true,
  turn: 1,
  sentence: 'Claude edited 2 files (+48 −12), now idle.',
  durationMs: 240_000,
  files: { count: 2, added: 48, deleted: 12, paths: [] },
  tests: 'all checks passed (3/3)',
  changes: [
    { path: 'src/auth/redirect.ts', status: 'M', added: 30, deleted: 8, binary: false },
    { path: 'src/auth/session.ts', status: 'M', added: 18, deleted: 4, binary: false },
  ],
};
const PATCH = 'diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts\n--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1,2 +1,2 @@\n-old line\n+new line\n';

function bridgeWith(result: ((withPatch?: boolean) => Promise<PaneResult>) | null, items: ChatItem[] = ITEMS) {
  const sendPaneMessage = vi.fn();
  const paneResult = result ? vi.fn(async (_id: string, withPatch?: boolean) => result(withPatch)) : undefined;
  const bridge = { paneChat: vi.fn(async () => chat(items)), sendPaneMessage, paneResult } as unknown as BridgeClient;
  return { bridge, sendPaneMessage, paneResult };
}

async function mount(bridge: BridgeClient, working = false) {
  await act(async () => {
    root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType working={working} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}
const card = () => host.querySelector('[data-testid="phone-result-card"]');
// The screen is placed at the top of the phone's root (here: the page body), outside the chat.
const screen = () => document.querySelector('[data-testid="phone-result-screen"]');
const button = (scope: Element | null, label: string) => [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const fresh = (withPatch?: boolean) => Promise.resolve(withPatch ? { ...RESULT, patch: PATCH, patchCut: false } : RESULT);

describe('the result card', () => {
  it('ends the chat with a summary, the files and the tests line', async () => {
    const { bridge } = bridgeWith(fresh);
    await mount(bridge);
    expect(card()).not.toBeNull();
    const text = card()!.textContent ?? '';
    expect(text).toContain('Done · 4 min');
    expect(text).toContain('The redirect keeps the page you came from.');
    expect(text).toContain('2 files · +48 −12');
    expect(text).toContain('all checks passed (3/3)');
  });

  it('is not there while the agent is still working', async () => {
    const { bridge } = bridgeWith(fresh);
    await mount(bridge, true);
    expect(card()).toBeNull();
  });

  it('opens full screen with the file list and the diff, and the screen closes with Back', async () => {
    const { bridge, paneResult } = bridgeWith(fresh);
    await mount(bridge);
    await act(async () => (card()!.querySelector('.ph-result-body') as HTMLButtonElement).click());
    expect(screen()).not.toBeNull();
    expect(paneResult).toHaveBeenCalledWith('p1', true);
    const text = screen()!.textContent ?? '';
    expect(text).toContain('src/auth/redirect.ts');
    expect(text).toContain('+30');
    expect(text).toContain('+new line');
    expect(screen()!.querySelector('.ph-dl-add')?.textContent).toContain('+new line');
    expect(screen()!.querySelector('.ph-dl-del')?.textContent).toContain('-old line');
    expect(screen()!.getAttribute('aria-modal')).toBe('true');
    act(() => (screen()!.querySelector('.ph-rscreen-back') as HTMLButtonElement).click());
    expect(screen()).toBeNull();
  });

  it('closes the screen on Escape', async () => {
    const { bridge } = bridgeWith(fresh);
    await mount(bridge);
    await act(async () => (card()!.querySelector('.ph-result-body') as HTMLButtonElement).click());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(screen()).toBeNull();
  });

  it('Ask to fix puts text in the box and sends nothing', async () => {
    const { bridge, sendPaneMessage } = bridgeWith(fresh);
    await mount(bridge);
    act(() => button(card(), 'Ask to fix').click());
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(field.value).toContain('Something is wrong with this change');
    expect(sendPaneMessage).not.toHaveBeenCalled();
  });

  it('Keep hides the card and it stays hidden for that turn', async () => {
    const { bridge } = bridgeWith(fresh);
    await mount(bridge);
    act(() => button(card(), 'Keep').click());
    expect(card()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount(bridge);
    expect(card()).toBeNull();
  });

  it('Share copies the summary and the files when the phone has no share sheet', async () => {
    const { bridge } = bridgeWith(fresh);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await mount(bridge);
    await act(async () => (card()!.querySelector('.ph-result-body') as HTMLButtonElement).click());
    await act(async () => button(screen(), 'Share').click());
    expect(writeText).toHaveBeenCalledTimes(1);
    const shared = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(shared).toContain('src/auth/session.ts (+18 −4)');
    expect(screen()!.textContent).toContain('Copied');
  });
});

describe('a turn the PC has no summary for', () => {
  it('shows only the files the chat shows, and Read all', async () => {
    const { bridge } = bridgeWith(() => Promise.resolve({ available: false }));
    await mount(bridge);
    const text = card()!.textContent ?? '';
    expect(text).toContain('src/auth/redirect.ts');
    expect(text).toContain('src/auth/session.ts');
    expect(text).not.toContain('all checks passed');
    expect(button(card(), 'Read all')).toBeTruthy();
    expect(button(card(), 'Keep')).toBeUndefined();
    expect(button(card(), 'Ask to fix')).toBeUndefined();
  });

  it('an old PC without the route gets the same files-only card', async () => {
    const { bridge } = bridgeWith(null);
    await mount(bridge);
    expect(card()!.textContent).toContain('src/auth/redirect.ts');
    expect(button(card(), 'Read all')).toBeTruthy();
  });

  it('a turn that changed no file and has no words has no card at all', async () => {
    const { bridge } = bridgeWith(null, [ITEMS[0]!, { kind: 'turnEnd', id: '2:0', at: null, outcome: 'completed', durationMs: 1000 }]);
    await mount(bridge);
    expect(card()).toBeNull();
  });
});
