// @vitest-environment jsdom
// The header's view switch: at every width one small dropdown, "View: Summary ▾", that opens a menu of three.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewModeToggle } from './ViewModeToggle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

/** A window that is (or is not) narrower than 600 px. */
function stubNarrow(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: narrow && query === '(max-width: 599px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const modeButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
const pill = () => document.querySelector<HTMLButtonElement>('button.ck-chat-mode-pill')!;
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];

function render(mode: 'summary' | 'normal' | 'verbose', onChange = vi.fn()) {
  act(() => root.render(<ViewModeToggle mode={mode} onChange={onChange} />));
  return onChange;
}

describe('ViewModeToggle on the desktop', () => {
  it('is one small dropdown, not a row of three buttons', () => {
    stubNarrow(false);
    render('summary');
    expect(modeButtons()).toHaveLength(0);
    expect(pill().textContent).toBe('View: Summary ▾');
    expect(pill().getAttribute('aria-label')).toBe('Chat view: Summary');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('reports the mode the person picks', () => {
    stubNarrow(false);
    const onChange = render('normal');
    act(() => pill().click());
    act(() => menuItems().find((b) => b.textContent === 'Verbose')!.click());
    expect(onChange).toHaveBeenCalledWith('verbose');
  });
});

describe('ViewModeToggle on a phone (under 600 px)', () => {
  it('shows one pill with the current mode and no row of buttons', () => {
    stubNarrow(true);
    render('normal');
    expect(modeButtons()).toHaveLength(0);
    expect(pill().textContent).toBe('View: Normal ▾');
    expect(pill().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('opens a menu of the three modes and reports the one picked, then closes', () => {
    stubNarrow(true);
    const onChange = render('normal');
    act(() => pill().click());
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    expect(menuItems().map((b) => b.textContent)).toEqual(['Summary', 'Normal', 'Verbose']);
    expect(menuItems().find((b) => b.textContent === 'Normal')?.getAttribute('aria-checked')).toBe('true');
    act(() => menuItems().find((b) => b.textContent === 'Summary')!.click());
    expect(onChange).toHaveBeenCalledWith('summary');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('closes the menu on Escape', () => {
    stubNarrow(true);
    render('verbose');
    act(() => pill().click());
    expect(menuItems()).toHaveLength(3);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
