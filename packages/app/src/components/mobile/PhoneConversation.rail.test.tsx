// @vitest-environment jsdom
// Screen level, phone: the message rail is wired into the phone's conversation (its own view, not the desktop's). One dash
// per message at the right edge, the thumb on a dash shows the message in a card above the finger, and a press jumps there.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { MESSAGE_RAIL_KEY, setMessageRail } from '../../lib/messageRail';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { PhoneConversation } from './PhoneConversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let scrolled: string[];

beforeEach(() => {
  setLanguagePref('en', false);
  setMessageRail(true);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.railId ?? '?');
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

function items(turns: number): ChatItem[] {
  const out: ChatItem[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ kind: 'user', id: `u${i}`, at: null, text: `question ${i}` });
    out.push({ kind: 'assistant', id: `a${i}`, at: null, text: `answer ${i}`, model: null, finalAnswer: true });
    out.push({ kind: 'turnEnd', id: `e${i}`, at: null, outcome: 'completed', durationMs: 1000 });
  }
  return out;
}

const render = (turns: number) => act(() => root.render(<PhoneConversation state="ready" reason={null} source="file" turns={groupTurns(items(turns)).turns} />));
const rail = () => host.querySelector<HTMLElement>('[data-testid="message-rail"]');
const dashes = () => [...host.querySelectorAll<HTMLElement>('[data-testid="message-rail-dash"]')];
const touch = (type: string, y: number) => act(() => void rail()!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y })));
const at = (i: number) => parseFloat(dashes()[i].style.top) + 1;

describe('the message rail on the phone', () => {
  it('shows one dash per message beside the conversation, and each message carries its id', () => {
    render(3);
    expect(dashes()).toHaveLength(6);
    expect([...host.querySelectorAll('[data-rail-id]')].map((n) => n.getAttribute('data-rail-id'))).toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2']);
    expect(rail()!.parentElement!.classList.contains('ck-mrail-host')).toBe(true);
    expect(host.querySelector('.ph-conv-body')!.contains(rail())).toBe(false);
  });

  it('is left out of a short conversation', () => {
    render(1);
    expect(rail()).toBeNull();
  });

  it('a press on a dash jumps to that message and shows its text in a card', () => {
    render(3);
    touch('pointerdown', at(4));
    expect(host.querySelector('[data-testid="message-rail-card"]')!.textContent).toContain('question 2');
    expect(scrolled[0]).toBe('u2');
    touch('pointerup', 0);
    expect(host.querySelector('[data-testid="message-rail-card"]')).toBeNull();
  });

  it('the Settings switch hides it', () => {
    render(3);
    act(() => setMessageRail(false));
    expect(rail()).toBeNull();
  });
});
