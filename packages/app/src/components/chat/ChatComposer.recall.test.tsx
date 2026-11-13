// @vitest-environment jsdom
// Up in an empty message box brings back what you sent (again for older ones, Down goes forward again); Ctrl+R opens
// "My messages", Enter puts the chosen one in the box, and nothing is ever sent from there.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { ChatComposer } from './ChatComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const onSend = vi.fn(async () => null);

beforeEach(() => {
  setLanguagePref('en', false);
  onSend.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const HISTORY = ['make the header blue', 'add a footer', 'run the tests'];
const box = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
const key = (target: Element, init: KeyboardEventInit) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

function mount(history = HISTORY) {
  act(() => root.render(<ChatComposer onSend={onSend} blockedReason={null} history={history} />));
}

describe('Up brings back what you sent', () => {
  it('shows the last message, then older ones, and Down walks back to an empty box', () => {
    mount();
    key(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('run the tests');
    key(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('add a footer');
    key(box(), { key: 'ArrowUp' });
    key(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('make the header blue');
    key(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('add a footer');
    key(box(), { key: 'ArrowDown' });
    key(box(), { key: 'ArrowDown' });
    expect(box().value).toBe('');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does nothing when you have typed something yourself', () => {
    mount();
    type(box(), 'my own words');
    key(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('my own words');
  });

  it('does nothing in a chat with no messages yet', () => {
    mount([]);
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    act(() => void box().dispatchEvent(event));
    expect(box().value).toBe('');
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Ctrl+R: My messages', () => {
  it('opens a list of what you sent, filters it, and fills the box without sending', () => {
    mount();
    key(box(), { key: 'r', ctrlKey: true });
    const dialog = host.querySelector('[data-testid="my-messages"]');
    expect(dialog).not.toBeNull();
    const options = () => [...host.querySelectorAll('.ck-mine-opt')].map((o) => o.textContent);
    expect(options()).toEqual(['run the tests', 'add a footer', 'make the header blue']);
    const input = host.querySelector<HTMLInputElement>('.ck-mine-input')!;
    expect(document.activeElement).toBe(input);
    type(input, 'foot');
    expect(options()).toEqual(['add a footer']);
    key(input, { key: 'Enter' });
    expect(host.querySelector('[data-testid="my-messages"]')).toBeNull();
    expect(box().value).toBe('add a footer');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Esc closes it and the box keeps the keyboard', () => {
    mount();
    key(box(), { key: 'r', ctrlKey: true });
    key(host.querySelector('.ck-mine-input')!, { key: 'Escape' });
    expect(host.querySelector('[data-testid="my-messages"]')).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('says so when nothing was sent yet', () => {
    mount([]);
    key(box(), { key: 'r', ctrlKey: true });
    expect(host.querySelector('.ck-mine-note')!.textContent).toBe('You have not sent anything yet.');
  });
});
