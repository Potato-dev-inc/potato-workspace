// @vitest-environment jsdom
// Screen level: the message rail is wired into the chat. It shows one dash per message, a click scrolls the chat to that
// message, Find matches brighten dashes, the Settings switch hides it, and using it never redraws a turn (N5-1).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { MESSAGE_RAIL_KEY, setMessageRail } from '../../lib/messageRail';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { ChatComposer } from './ChatComposer';
import { SessionChatView, turnRenders } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let scrolled: string[];

beforeEach(() => {
  setLanguagePref('en', false);
  setMessageRail(true);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.railId ?? this.dataset.turnId ?? '?');
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.removeItem(MESSAGE_RAIL_KEY);
});

function chatItems(turns: number): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < turns; i++) {
    items.push({ kind: 'user', id: `u${i}`, at: null, text: i === 1 ? 'Where is the banana code?' : `question ${i}` });
    items.push({ kind: 'assistant', id: `a${i}`, at: null, text: i === 1 ? 'The banana lives in fruit.ts' : `answer ${i}`, model: null, finalAnswer: true });
    items.push({ kind: 'turnEnd', id: `e${i}`, at: null, outcome: 'completed', durationMs: 1000 });
  }
  return items;
}

function Chat({ turns = 3 }: { turns?: number }) {
  return (
    <SessionChatView
      state="ready"
      reason={null}
      source="acp"
      turns={groupTurns(chatItems(turns)).turns}
      model={null}
      cliVersion={null}
      paneId="p-rail"
      composer={<ChatComposer onSend={async () => null} blockedReason={null} />}
    />
  );
}

const rail = () => host.querySelector<HTMLElement>('[data-testid="message-rail"]');
const dashes = () => [...host.querySelectorAll<HTMLElement>('[data-testid="message-rail-dash"]')];
const pointer = (type: string, y: number) => act(() => void rail()!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y })));
const at = (i: number) => parseFloat(dashes()[i].style.top) + 1;

describe('the message rail in the chat', () => {
  it('shows one dash per message beside the chat, and each message carries its id', () => {
    act(() => root.render(<Chat />));
    expect(rail()).not.toBeNull();
    expect(dashes()).toHaveLength(6);
    expect([...host.querySelectorAll('[data-rail-id]')].map((n) => n.getAttribute('data-rail-id'))).toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2']);
    // It sits next to the scrolling box, not inside it.
    expect(rail()!.parentElement).toBe(host.querySelector('.ck-chat-main'));
    expect(host.querySelector('.ck-chat-body')!.contains(rail())).toBe(false);
  });

  it('is not drawn for a short chat', () => {
    act(() => root.render(<Chat turns={1} />));
    expect(rail()).toBeNull();
  });

  it('a click on a dash scrolls the chat to that message', () => {
    act(() => root.render(<Chat />));
    pointer('pointerdown', at(3));
    pointer('pointerup', 0);
    expect(scrolled[0]).toBe('a1');
  });

  it('Alt+Up jumps to the previous message of the person', () => {
    act(() => root.render(<Chat />));
    const view = host.querySelector<HTMLElement>('[data-testid="session-chat"]')!;
    act(() => void view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true })));
    // Nothing is being read yet (no observer in this test), so the first message is "current" and there is none before it.
    expect(scrolled).toEqual([]);
    act(() => void view.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })));
    expect(scrolled[0]).toBe('u1');
  });

  it('Ctrl+F matches brighten their dashes', async () => {
    act(() => root.render(<Chat />));
    act(() => void host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true })));
    const input = host.querySelector<HTMLInputElement>('.ck-find-input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'banana');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(dashes().map((d) => d.classList.contains('is-hit'))).toEqual([false, false, true, true, false, false]);
  });

  it('the Settings switch hides it and brings it back', () => {
    act(() => root.render(<Chat />));
    act(() => setMessageRail(false));
    expect(rail()).toBeNull();
    act(() => setMessageRail(true));
    expect(rail()).not.toBeNull();
  });

  it('hovering and jumping draw no turn again (the turns stay memoised)', () => {
    act(() => root.render(<Chat turns={20} />));
    turnRenders.count = 0;
    pointer('pointermove', at(5));
    pointer('pointerdown', at(8));
    pointer('pointermove', at(12));
    pointer('pointerup', 0);
    expect(turnRenders.count).toBe(0);
  });
});
