// @vitest-environment jsdom
// A chat opens at its latest message: after a switch away and back, when history comes in late, and when a picture
// changes the height. While the reader is at the end, new output keeps it there. Scrolled up, new output does not move
// the view and `Jump to latest` shows until the reader is back at the end or presses it.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW_PX = 400;
let host: HTMLDivElement;
let root: Root;
/** How tall the conversation is, in pixels. The test changes it the way a streamed reply or a picture would. */
let contentPx: number;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  contentPx = 0;
  // jsdom has no layout: only the chat body has a height and a view.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ck-chat-body') ? contentPx : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('ck-chat-body') ? VIEW_PX : 0;
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 16, 9, min, 0)).toISOString();

/** Question, answer and end for each turn from `from` up to (not including) `to`. */
function history(from: number, to: number): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = from; i < to; i++) {
    items.push({ kind: 'user', id: `u${i}`, at: at(i), text: `question ${i}` });
    items.push({ kind: 'assistant', id: `a${i}`, at: at(i), text: `answer ${i}`, model: null, finalAnswer: true });
    items.push({ kind: 'turnEnd', id: `e${i}`, at: at(i), outcome: 'completed', durationMs: 1000 });
  }
  return items;
}

const chat = (paneId: string, items: ChatItem[], pending?: ReactNode) => (
  <SessionChatView state="ready" reason={null} turns={groupTurns(items).turns} model={null} cliVersion={null} paneId={paneId} pending={pending} />
);
const render = (node: ReactNode) => act(() => root.render(node));
const body = () => host.querySelector<HTMLElement>('.ck-chat-body')!;
const jumpButton = () => host.querySelector<HTMLButtonElement>('[data-testid="jump-latest"]');
/** The reader moves the scroll bar to `top`, and the browser tells the page about it. */
function readerScrollsTo(top: number) {
  body().scrollTop = top;
  act(() => void body().dispatchEvent(new Event('scroll')));
}

describe('opening a chat lands on the latest message', () => {
  it('ends at the bottom on open, and again after a switch away and back', () => {
    contentPx = 3000;
    render(chat('p-a', history(0, 30)));
    expect(body().scrollTop).toBe(3000);

    render(<p>Another screen</p>);
    expect(host.querySelector('.ck-chat-body')).toBeNull();

    render(chat('p-a', history(0, 30)));
    expect(body().scrollTop).toBe(3000);
    expect(jumpButton()).toBeNull();
  });

  it('ends at the bottom after switching to another pane and back without unmounting', () => {
    contentPx = 3000;
    render(chat('p-a', history(0, 30)));
    readerScrollsTo(500);
    expect(jumpButton()).not.toBeNull();

    contentPx = 2200;
    render(chat('p-b', history(0, 22)));
    expect(body().scrollTop).toBe(2200);

    contentPx = 3000;
    render(chat('p-a', history(0, 30)));
    expect(body().scrollTop).toBe(3000);
    expect(jumpButton()).toBeNull();
  });

  it('follows history that comes in after the chat is already open', () => {
    contentPx = 0;
    render(chat('p-late', []));
    contentPx = 3000;
    render(chat('p-late', history(0, 30)));
    expect(body().scrollTop).toBe(3000);
  });

  it('follows a picture that changes the height after it loads', () => {
    contentPx = 1000;
    render(chat('p-img', history(0, 10), <img alt="diagram" />));
    expect(body().scrollTop).toBe(1000);

    contentPx = 1800;
    const img = host.querySelector('img')!;
    act(() => void img.dispatchEvent(new Event('load')));
    expect(body().scrollTop).toBe(1800);
  });
});

describe('new output while the reader is at the end', () => {
  it('stays at the bottom as new messages arrive', () => {
    contentPx = 3000;
    render(chat('p-live', history(0, 30)));
    contentPx = 3400;
    render(chat('p-live', history(0, 31)));
    expect(body().scrollTop).toBe(3400);
    contentPx = 3900;
    render(chat('p-live', history(0, 32)));
    expect(body().scrollTop).toBe(3900);
    expect(jumpButton()).toBeNull();
  });
});

describe('scrolled up', () => {
  it('new messages do not move the view, and Jump to latest shows', () => {
    contentPx = 3000;
    render(chat('p-up', history(0, 30)));
    readerScrollsTo(1000);
    expect(jumpButton()).not.toBeNull();

    contentPx = 3400;
    render(chat('p-up', history(0, 31)));
    expect(body().scrollTop).toBe(1000);
    expect(jumpButton()).not.toBeNull();
  });

  it('Jump to latest goes to the newest message and follows output again', () => {
    contentPx = 3000;
    render(chat('p-up', history(0, 30)));
    readerScrollsTo(1000);
    act(() => void jumpButton()!.click());
    expect(body().scrollTop).toBe(3000);
    expect(jumpButton()).toBeNull();

    contentPx = 3500;
    render(chat('p-up', history(0, 31)));
    expect(body().scrollTop).toBe(3500);
  });

  it('the button goes when the reader scrolls back to the end', () => {
    contentPx = 3000;
    render(chat('p-up', history(0, 30)));
    readerScrollsTo(1000);
    expect(jumpButton()).not.toBeNull();
    readerScrollsTo(3000);
    expect(jumpButton()).toBeNull();
  });
});
