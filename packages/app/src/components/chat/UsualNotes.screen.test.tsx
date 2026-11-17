// @vitest-environment jsdom
// Screen test through the real chat view: the "more than usual" note under a heavy answer, "Don't show again" hides it
// for good (also after the chat remounts), and the chat View menu's switch brings it back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { getUsualNotesOn } from '../../lib/usual-notes';
import { SessionChatView } from './SessionChatView';
import { ViewModeToggle } from './ViewModeToggle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function turn(n: number, reads: number, ms: number): ChatItem[] {
  const items: ChatItem[] = [{ kind: 'user', id: `u${n}`, at: null, text: `ask ${n}` }];
  for (let i = 0; i < reads; i++) {
    items.push({ kind: 'toolCall', id: `c${n}-${i}`, at: null, callId: `k${n}-${i}`, name: 'Read', summary: `f${n}-${i}.ts`, paths: [`src/f${n}-${i}.ts`] });
    items.push({ kind: 'toolResult', id: `r${n}-${i}`, at: null, callId: `k${n}-${i}`, ok: true, output: 'x' });
  }
  items.push({ kind: 'assistant', id: `a${n}`, at: null, text: `done ${n}`, model: null, finalAnswer: true });
  items.push({ kind: 'turnEnd', id: `e${n}`, at: null, outcome: 'completed', durationMs: ms });
  return items;
}

// Three ordinary answers, then one that took far longer than usual.
const chatItems = (): ChatItem[] => [...turn(1, 2, 30_000), ...turn(2, 2, 40_000), ...turn(3, 2, 35_000), ...turn(4, 2, 400_000)];

const renderChat = () =>
  act(() =>
    root.render(
      <>
        <ViewModeToggle mode="summary" onChange={vi.fn()} />
        <SessionChatView state="ready" reason={null} turns={groupTurns(chatItems()).turns} model={null} cliVersion={null} paneId="p-usual" />
      </>,
    ),
  );
const note = () => host.querySelector<HTMLElement>('[data-testid="turn-price-tip"]');
const dismiss = () => host.querySelector<HTMLButtonElement>('.ck-price-dismiss');
const mark = () => host.querySelector('.ck-price-mark');
const pill = () => document.querySelector<HTMLButtonElement>('.ck-chat-mode-pill')!;
/** The View menu's switch for the note: the app's own switch (role="switch"), named by its label. */
const usualSwitch = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label*="\'more than usual\' notes"]');
const usualOn = () => usualSwitch()?.getAttribute('aria-checked') === 'true';

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('"more than usual" note in the real chat view', () => {
  it('shows the note under the heavy answer with a "Don\'t show again" action', () => {
    renderChat();
    expect(note()).not.toBeNull();
    expect(note()!.textContent).toContain('This took much more than usual for this chat.');
    expect(mark()).not.toBeNull();
    expect(dismiss()!.textContent).toBe("Don't show again");
  });

  it('pressing "Don\'t show again" hides the note, and it stays hidden after a remount', () => {
    renderChat();
    act(() => dismiss()!.click());
    expect(note()).toBeNull();
    expect(mark()).toBeNull();
    expect(host.querySelector('[data-testid="turn-price"]')).not.toBeNull();
    expect(getUsualNotesOn()).toBe(false);

    act(() => root.unmount());
    root = createRoot(host);
    renderChat();
    expect(note()).toBeNull();
    expect(mark()).toBeNull();
  });

  it('the chat View menu switch turns the note back on', () => {
    renderChat();
    act(() => dismiss()!.click());
    expect(note()).toBeNull();

    act(() => pill().click());
    expect(usualOn()).toBe(false);
    act(() => usualSwitch()!.click());
    expect(usualOn()).toBe(true);
    expect(getUsualNotesOn()).toBe(true);
    expect(note()).not.toBeNull();
  });
});
