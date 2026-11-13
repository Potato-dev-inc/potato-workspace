// @vitest-environment jsdom
// "New since you looked": a thin line above what is new with a count of answers and changed files, a button that jumps
// to the latest, and the line goes when the reader reaches the end. A short chat that fits on screen has no line.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { readSeen, writeSeen } from '../../lib/chatSince';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let scrollTops: number;

/** jsdom has no layout: say how tall the conversation is and how much of it is in view. */
function layout(scrollHeight: number, clientHeight: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => clientHeight });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setLanguagePref('en', false);
  localStorage.clear();
  scrollTops = 0;
  Element.prototype.scrollIntoView = function () {
    scrollTops += 1;
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 13, 1, min, 0)).toISOString();
const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: at(0), text: 'one' },
  { kind: 'assistant', id: 'a1', at: at(1), text: 'done one', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: at(2), outcome: 'completed', durationMs: 1000 },
  { kind: 'user', id: 'u2', at: at(10), text: 'two' },
  { kind: 'toolCall', id: 'c2', at: at(11), callId: 'k2', name: 'Edit', summary: 'a.ts', paths: ['a.ts'], writes: true },
  { kind: 'assistant', id: 'a2', at: at(12), text: 'done two', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e2', at: at(13), outcome: 'completed', durationMs: 1000 },
];
const looked = Date.parse(at(5));

const render = () =>
  act(() => root.render(<SessionChatView state="ready" reason={null} turns={groupTurns(ITEMS).turns} model={null} cliVersion={null} paneId="p-since" />));
const body = () => host.querySelector<HTMLElement>('.ck-chat-body')!;

describe('New since you looked', () => {
  it('shows the line with the counts above the first new turn, and a Jump to latest button', () => {
    layout(2000, 400);
    writeSeen('p-since', looked);
    render();
    const line = host.querySelector('[data-testid="since-line"]')!;
    expect(line.textContent).toBe('New since you looked · 1 answer · 1 file changed');
    expect(line.nextElementSibling?.getAttribute('data-turn-id')).toBe('u2');
    expect(host.querySelector('[data-testid="jump-latest"]')).not.toBeNull();
    expect(scrollTops).toBeGreaterThan(0);
  });

  it('goes when the reader reaches the end, and the moment is kept', () => {
    layout(2000, 400);
    writeSeen('p-since', looked);
    render();
    const el = body();
    el.scrollTop = 1590;
    // The scroll that opening at the line causes does not count; the reader's own scroll does.
    act(() => void el.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-testid="since-line"]')).not.toBeNull();
    vi.setSystemTime(Date.now() + 1000);
    act(() => void el.dispatchEvent(new Event('scroll')));
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
    expect(host.querySelector('[data-testid="jump-latest"]')).toBeNull();
    expect(readSeen('p-since')!).toBeGreaterThan(looked);
  });

  it('Jump to latest goes to the end and drops the line', () => {
    layout(2000, 400);
    writeSeen('p-since', looked);
    render();
    act(() => void host.querySelector<HTMLButtonElement>('[data-testid="jump-latest"]')!.click());
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
    expect(body().scrollTop).toBe(2000);
  });

  it('shows no line when everything is already in view, or the chat was never looked at', () => {
    layout(300, 400);
    writeSeen('p-since', looked);
    render();
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.clear();
    layout(2000, 400);
    render();
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
  });

  it('shows no line when nothing is newer than the last look', () => {
    layout(2000, 400);
    writeSeen('p-since', Date.parse(at(30)));
    render();
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
  });
});
