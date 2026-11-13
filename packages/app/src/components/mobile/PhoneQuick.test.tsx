// @vitest-environment jsdom
// P17 on the phone: chips made from what the agent asked fill the box (one more tap sends); "/" opens the saved prompts, kept on
// the phone only; a saved prompt fills the box; the list can be edited in place.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { SAVED_PROMPTS_KEY } from '../../lib/phone-quick';
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
    root.render(<PhoneComposer onSend={onSend} blockedReason={null} draftKey="p1" model="Sonnet 5" {...props} />);
  });
  return onSend;
}
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
function typeText(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const chips = () => [...host.querySelectorAll('[data-testid="phone-quick"] button')] as HTMLButtonElement[];

describe('quick replies', () => {
  it('shows the chips above the box, and a chip fills the box without sending', () => {
    const onSend = mount({ quick: ['continue', 'yes', 'no'] });
    expect(chips().map((c) => c.textContent)).toEqual(['Continue', 'Yes, go ahead', 'No, do not']);
    act(() => chips()[0]!.click());
    expect(field().value).toBe('Continue');
    expect(onSend).not.toHaveBeenCalled();
    // The chips make room once there is text; Send sends.
    expect(host.querySelector('[data-testid="phone-quick"]')).toBeNull();
    const send = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('shows nothing when the agent asked nothing', () => {
    mount({ quick: [] });
    expect(host.querySelector('[data-testid="phone-quick"]')).toBeNull();
  });

  it('is switched off while the box is switched off', () => {
    mount({ quick: ['yes', 'no'], blockedReason: 'Sign in on the PC first.' });
    expect(host.querySelector('[data-testid="phone-quick"]')).toBeNull();
  });

  it('a fill from outside (Ask to fix) puts its text in the box and the same text can fill again', () => {
    mount({ fill: { text: 'Please fix: ', nonce: 1 } });
    expect(field().value).toBe('Please fix: ');
    typeText('changed');
    act(() => {
      root.render(<PhoneComposer onSend={vi.fn(async () => null)} blockedReason={null} draftKey="p1" model={null} fill={{ text: 'Please fix: ', nonce: 2 }} />);
    });
    expect(field().value).toBe('Please fix: ');
  });
});

describe('saved prompts', () => {
  it('"/" opens the saved prompts and a prompt fills the box', () => {
    const onSend = mount();
    typeText('/');
    const panel = host.querySelector('[data-testid="phone-saved"]')!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('Run the tests and tell me what fails');
    act(() => (panel.querySelector('.ph-saved-pick') as HTMLButtonElement).click());
    expect(field().value).toBe('Run the tests and tell me what fails');
    expect(host.querySelector('[data-testid="phone-saved"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('what is typed after the slash filters the list', () => {
    mount();
    typeText('/expl');
    const panel = host.querySelector('[data-testid="phone-saved"]')!;
    expect(panel.querySelectorAll('.ph-saved-pick')).toHaveLength(1);
    expect(panel.textContent).toContain('Explain what you changed');
    typeText('/zzz');
    expect(host.querySelector('[data-testid="phone-saved"]')!.textContent).toContain('No saved prompt matches');
  });

  it('a prompt can be added and removed, and the list is kept on this phone only', () => {
    mount();
    typeText('/');
    const input = host.querySelector('.ph-saved-add input') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      set.call(input, 'Open a pull request');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => (host.querySelector('.ph-saved-add button') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="phone-saved"]')!.textContent).toContain('Open a pull request');
    expect(JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY)!)[0]).toBe('Open a pull request');
    act(() => (host.querySelector('.ph-saved-del') as HTMLButtonElement).click());
    expect(JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY)!)).not.toContain('Open a pull request');
  });

  it('Close hides the panel until the slash is gone', () => {
    mount();
    typeText('/');
    act(() => (host.querySelector('.ph-saved-close') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="phone-saved"]')).toBeNull();
    typeText('');
    typeText('/');
    expect(host.querySelector('[data-testid="phone-saved"]')).not.toBeNull();
  });
});
