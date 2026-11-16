// @vitest-environment jsdom
// The bar's popups (Shape list, Colour, More) are the shared Menu: they open from their button, Escape and an outside press
// close them, and an outside press closes a popup without opening the next one. Up/Down move between the items.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { initialState, openBar, togglePopup } from '../../lib/markup/model';
import { MarkupBar, type BarActions } from './MarkupBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const btn = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
const menu = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const key = (name: string) => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));
const press = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));

/** A bar that keeps its popup state in a variable, the way MarkupHost does. */
function renderBar(start = openBar(initialState(true))) {
  let state = start;
  const actions: BarActions = {
    tool: vi.fn(),
    shape: vi.fn(),
    color: vi.fn(),
    popup: vi.fn((p) => {
      state = togglePopup(state, p);
      draw();
    }),
    closePopup: vi.fn(() => {
      state = { ...state, popup: null };
      draw();
    }),
    undo: vi.fn(),
    clear: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  };
  const draw = () => act(() => root.render(<MarkupBar state={state} width={900} actions={actions} />));
  draw();
  return actions;
}

describe('the mark-up bar popups', () => {
  it('the colour popup opens with its swatches, and the first one takes the focus', () => {
    renderBar();
    act(() => btn('markup-colour').click());
    expect(menu('markup-colors-menu')).not.toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toMatch(/^markup-colour-/);
    expect(menu('markup-colors-menu')!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(1);
  });

  it('Down moves to the next swatch and Escape closes the popup', () => {
    const actions = renderBar();
    act(() => btn('markup-colour').click());
    const first = document.activeElement;
    key('ArrowDown');
    expect(document.activeElement).not.toBe(first);
    key('Escape');
    expect(menu('markup-colors-menu')).toBeNull();
    expect(actions.closePopup).toHaveBeenCalled();
  });

  it('an outside press closes the popup once and does not reopen it', () => {
    const actions = renderBar();
    act(() => btn('markup-shapes').click());
    expect(menu('markup-shapes-menu')).not.toBeNull();
    press(document.body);
    expect(menu('markup-shapes-menu')).toBeNull();
    expect(actions.popup).toHaveBeenCalledTimes(1);
  });
});
