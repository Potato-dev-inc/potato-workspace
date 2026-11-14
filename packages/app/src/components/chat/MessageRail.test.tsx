// @vitest-environment jsdom
// The message rail: one dash per message, the current one follows what the chat shows, hover shows the message in a
// card, a click or a drag scrolls to the right message, Alt+Up / Alt+Down walk the person's own messages, and Find
// matches brighten their dashes. The chat's boxes are drawn by the test; the browser's observers are faked.
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { MESSAGE_RAIL_KEY, setMessageRail } from '../../lib/messageRail';
import { MessageRail } from './MessageRail';
import type { RailEntry } from './messageRailModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let scrolled: string[];
let observer: { callback: IntersectionObserverCallback; targets: Element[] } | null;

const ENTRIES: RailEntry[] = [
  { id: 'u1', turnId: 't1', who: 'you', text: 'Fix the login page, please' },
  { id: 'a1', turnId: 't1', who: 'agent', text: 'I will look at the login flow first.' },
  { id: 'a2', turnId: 't1', who: 'agent', text: 'Found it: the redirect reads the profile too early.' },
  { id: 'u2', turnId: 't2', who: 'you', text: 'Does it work when the session expired?' },
  { id: 'a3', turnId: 't2', who: 'agent', text: 'Yes. Expired goes back to sign-in.' },
  { id: 'u3', turnId: 't3', who: 'you', text: 'Commit it' },
];

beforeEach(() => {
  setLanguagePref('en', false);
  setMessageRail(true);
  scrolled = [];
  observer = null;
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.railId ?? '?');
  };
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    targets: Element[] = [];
    constructor(callback: IntersectionObserverCallback) {
      observer = { callback, targets: this.targets };
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    disconnect() {}
    unobserve() {}
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  localStorage.removeItem(MESSAGE_RAIL_KEY);
});

function Harness({ entries = ENTRIES, findQuery = '' }: { entries?: RailEntry[]; findQuery?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} data-testid="chat-root">
      <div ref={scrollRef}>
        {entries.map((e) => (
          <div key={e.id} data-rail-id={e.id}>
            {e.text}
          </div>
        ))}
      </div>
      <MessageRail entries={entries} scrollRef={scrollRef} rootRef={rootRef} findQuery={findQuery} />
    </div>
  );
}

const dashes = () => [...host.querySelectorAll<HTMLElement>('[data-testid="message-rail-dash"]')];
const rail = () => host.querySelector<HTMLElement>('[data-testid="message-rail"]')!;
const card = () => host.querySelector<HTMLElement>('[data-testid="message-rail-card"]');
const pointer = (type: string, y: number, init: MouseEventInit = {}) => act(() => void rail().dispatchEvent(new MouseEvent(type, { bubbles: true, clientY: y, ...init })));
const at = (i: number, plus = 1) => parseFloat(dashes()[i].style.top) + plus;
const intersect = (ids: string[], isIntersecting = true) =>
  act(() =>
    observer!.callback(
      ids.map((id) => ({ target: host.querySelector(`[data-rail-id="${id}"]`)!, isIntersecting }) as unknown as IntersectionObserverEntry),
      {} as IntersectionObserver,
    ),
  );

describe('MessageRail', () => {
  it('draws one dash per message', () => {
    act(() => root.render(<Harness />));
    expect(dashes()).toHaveLength(ENTRIES.length);
    expect(rail().getAttribute('aria-label')).toMatch(/Message rail/);
    expect(rail().tabIndex).toBe(0);
  });

  it('is left out under four messages, and when the setting is off', () => {
    act(() => root.render(<Harness entries={ENTRIES.slice(0, 3)} />));
    expect(host.querySelector('[data-testid="message-rail"]')).toBeNull();
    act(() => root.render(<Harness />));
    expect(host.querySelector('[data-testid="message-rail"]')).not.toBeNull();
    act(() => setMessageRail(false));
    expect(host.querySelector('[data-testid="message-rail"]')).toBeNull();
  });

  it('the current dash follows the message the chat shows', () => {
    act(() => root.render(<Harness />));
    expect(observer!.targets).toHaveLength(ENTRIES.length);
    intersect(['a1']);
    expect(dashes().findIndex((d) => d.classList.contains('is-current'))).toBe(1);
    intersect(['a1'], false);
    intersect(['a3']);
    expect(dashes().findIndex((d) => d.classList.contains('is-current'))).toBe(4);
    expect(dashes().filter((d) => d.classList.contains('is-current'))).toHaveLength(1);
  });

  it('hover brightens the dash and shows who wrote the message and its text', () => {
    act(() => root.render(<Harness />));
    expect(card()).toBeNull();
    pointer('pointermove', at(3));
    expect(dashes()[3].classList.contains('is-hover')).toBe(true);
    expect(card()!.textContent).toContain('You');
    expect(card()!.textContent).toContain('Does it work when the session expired?');
    pointer('pointermove', at(4));
    expect(card()!.textContent).toContain('Agent');
    expect(card()!.textContent).toContain('Expired goes back to sign-in.');
    pointer('pointerout', 0);
    expect(card()).toBeNull();
  });

  it('a click scrolls to the message of that dash and washes it', () => {
    act(() => root.render(<Harness />));
    pointer('pointerdown', at(2));
    pointer('pointerup', 0);
    expect(scrolled[0]).toBe('a2');
    expect(host.querySelector('[data-rail-id="a2"]')!.classList.contains('ck-mrail-flash')).toBe(true);
  });

  it('dragging along the dashes scrubs through the messages, once per dash', () => {
    act(() => root.render(<Harness />));
    pointer('pointerdown', at(0));
    pointer('pointermove', at(1));
    pointer('pointermove', at(1, 2));
    pointer('pointermove', at(3));
    pointer('pointerup', 0);
    expect([...new Set(scrolled)]).toEqual(['u1', 'a1', 'u2']);
  });

  it('Alt+Up and Alt+Down jump between the own messages of the person', () => {
    act(() => root.render(<Harness />));
    intersect(['a2']);
    const chat = host.querySelector<HTMLElement>('[data-testid="chat-root"]')!;
    const key = (k: string) => act(() => void chat.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true })));
    key('ArrowUp');
    expect(scrolled[0]).toBe('u1');
    key('ArrowDown');
    expect(scrolled[1]).toBe('u2');
    // Without Alt nothing moves.
    act(() => void chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(scrolled).toHaveLength(2);
  });

  it('the rail itself takes the arrow keys when it has the keyboard', () => {
    act(() => root.render(<Harness />));
    intersect(['u3']);
    act(() => void rail().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    expect(scrolled[0]).toBe('u2');
  });

  it('Find matches brighten their dashes', () => {
    act(() => root.render(<Harness findQuery="login" />));
    const lit = dashes().map((d, i) => (d.classList.contains('is-hit') ? i : -1)).filter((i) => i >= 0);
    expect(lit).toEqual([0, 1]);
    act(() => root.render(<Harness findQuery="" />));
    expect(dashes().some((d) => d.classList.contains('is-hit'))).toBe(false);
  });

  it('keeps its dashes inside the rail for a very long chat', () => {
    const many: RailEntry[] = Array.from({ length: 2000 }, (_, i) => ({ id: `m${i}`, turnId: `t${i}`, who: i % 2 ? 'agent' : 'you', text: `message ${i}` }));
    act(() => root.render(<Harness entries={many} />));
    expect(dashes().length).toBeLessThan(100);
    expect(dashes().length).toBeGreaterThan(10);
  });
});
