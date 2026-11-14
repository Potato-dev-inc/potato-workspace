// @vitest-environment jsdom
// The phone's one message box: it grows with the text, Send sends and clears it, a refused message says why, and the "+"
// menu and the model pill are there.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { PhoneComposer } from './PhoneComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

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
});

function mount(props: Partial<Parameters<typeof PhoneComposer>[0]> = {}) {
  const onSend = vi.fn(async () => null as string | null);
  act(() => {
    root.render(<PhoneComposer onSend={props.onSend ?? onSend} blockedReason={null} draftKey="p1" model="Sonnet 5" {...props} />);
  });
  return { onSend };
}

const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const send = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PhoneComposer', () => {
  it('has the plus, the model pill, the mic and Send in one box', () => {
    mount();
    expect(host.querySelector('[aria-label="Add"]')).not.toBeNull();
    expect(host.querySelector('.ph-comp-model')?.textContent).toBe('Model: Sonnet 5');
    expect(host.querySelector('[data-testid="phone-mic"]')).not.toBeNull();
    expect(send()).not.toBeNull();
    expect(send().disabled).toBe(true);
  });

  it('grows with the text, up to a limit', () => {
    mount();
    const el = field();
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 30 + el.value.split('\n').length * 22 });
    type('one');
    const one = parseFloat(el.style.height);
    type('one\ntwo\nthree\nfour');
    const four = parseFloat(el.style.height);
    expect(four).toBeGreaterThan(one);
    type(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'));
    // Six lines at the fallback line height, never more.
    expect(parseFloat(el.style.height)).toBeLessThanOrEqual(6 * 22);
  });

  it('Send sends the trimmed text and clears the box; Enter is a new line, not a send', async () => {
    const { onSend } = mount();
    type('  fix the login test ');
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(onSend).toHaveBeenCalledWith('fix the login test');
    expect(field().value).toBe('');
  });

  it('keeps the text and says why when the message is refused', async () => {
    const onSend = vi.fn(async () => 'The agent has closed.');
    mount({ onSend });
    type('hello');
    await act(async () => send().click());
    expect(field().value).toBe('hello');
    expect(host.querySelector('[data-testid="phone-composer-note"]')?.textContent).toBe('The agent has closed.');
  });

  it('is off, with the reason, when the chat cannot take a message', () => {
    mount({ blockedReason: 'Sign in on the PC first.' });
    expect(field().disabled).toBe(true);
    expect(host.textContent).toContain('Sign in on the PC first.');
    expect(send().disabled).toBe(true);
  });

  it('the plus menu lists camera, photos, files and paste, and says so when the PC cannot take files', () => {
    mount();
    act(() => (host.querySelector('[aria-label="Add"]') as HTMLButtonElement).click());
    const menu = host.querySelector('[data-testid="phone-plus-menu"]')!;
    expect(menu.textContent).toContain('Camera');
    expect(menu.textContent).toContain('Photos');
    expect(menu.textContent).toContain('Files');
    expect(menu.textContent).toContain('Paste');
    expect(menu.textContent).toContain('Not on this PC yet');
  });

  it('keeps an unsent message per chat', () => {
    vi.useFakeTimers();
    try {
      mount();
      type('half a thought');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      act(() => root.unmount());
      root = createRoot(host);
      mount();
      expect(field().value).toBe('half a thought');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Step 9 composer states', () => {
  it('says Retry after a refused message, and Retry sends the same text again', async () => {
    const onSend = vi.fn(async () => 'Could not reach your PC.' as string | null);
    mount({ onSend });
    type('hello');
    await act(async () => send().click());
    const retry = host.querySelector('[data-testid="phone-retry"]') as HTMLButtonElement;
    expect(retry).not.toBeNull();
    await act(async () => retry.click());
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenLastCalledWith('hello');
  });

  it('a send that throws keeps the text and shows a plain error with Retry', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('network');
    });
    mount({ onSend: onSend as never });
    type('hello');
    await act(async () => send().click());
    expect(field().value).toBe('hello');
    expect(host.querySelector('[data-testid="phone-composer-note"]')?.textContent).toContain('did not go');
    expect(host.querySelector('[data-testid="phone-retry"]')).not.toBeNull();
  });

  it('has a placeholder for each state and Send is orange only with text', () => {
    mount({ working: true, onStop: async () => null });
    expect(field().placeholder).toBe('Add to queue');
    expect(host.querySelector('[data-testid="phone-stop"]')).not.toBeNull();
    type('more');
    expect(send().hasAttribute('data-ready')).toBe(true);
    expect(host.querySelector('[data-testid="phone-stop-small"]')).not.toBeNull();
  });

  it('says Type an answer when asked and Offline when the PC is away', () => {
    mount({ asking: true });
    expect(field().placeholder).toBe('Type an answer');
    mount({ offline: true });
    expect(field().placeholder).toBe('Offline. Messages will wait.');
  });
});
