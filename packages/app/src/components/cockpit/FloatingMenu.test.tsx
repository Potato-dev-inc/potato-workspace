// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeFloating } from './FloatingMenu';
import { PaneMoreMenu } from './PaneMoreMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = { width: 1000, height: 700 };
const size = { width: 200, height: 100 };

describe('placeFloating', () => {
  it('opens under the button, lined up with its right edge', () => {
    const p = placeFloating({ left: 700, right: 730, top: 10, bottom: 34 }, size, view);
    expect(p).toMatchObject({ left: 530, top: 40, up: false });
  });
  it('flips above the button when there is no room below', () => {
    const p = placeFloating({ left: 700, right: 730, top: 650, bottom: 674 }, size, view);
    expect(p.up).toBe(true);
    expect(p.top).toBe(650 - 6 - 100);
  });
  it('prefer up (a footer button) opens above', () => {
    expect(placeFloating({ left: 10, right: 40, top: 600, bottom: 624 }, size, view, 'start', 'up').up).toBe(true);
  });
  it('slides back inside the window at the left and right edges', () => {
    expect(placeFloating({ left: 0, right: 20, top: 10, bottom: 34 }, size, view, 'end').left).toBe(8);
    expect(placeFloating({ left: 980, right: 1000, top: 10, bottom: 34 }, size, view, 'start').left).toBe(792);
  });
  it('a menu taller than the room scrolls instead of leaving the window', () => {
    const p = placeFloating({ left: 10, right: 40, top: 300, bottom: 324 }, { width: 200, height: 900 }, view);
    expect(p.maxHeight).toBeLessThanOrEqual(700);
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
});

describe('PaneMoreMenu in the top layer', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    host.className = 'cockpit';
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = (onPick = vi.fn(), onSelect = vi.fn()) => {
    // The button sits inside an overflow-hidden pane, like the real header.
    act(() =>
      root.render(
        createElement(
          'div',
          { className: 'ck-pane-head', style: { overflow: 'hidden' } },
          createElement(PaneMoreMenu<'transcript' | 'receipt'>, {
            value: 'chat',
            onPick,
            items: [
              { id: 'transcript', label: 'Transcript' },
              { id: 'receipt', label: 'Receipt' },
            ],
            actions: [{ id: 'handoff', label: 'Hand off', onSelect }],
          }),
        ),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    return { onPick, onSelect };
  };

  it('renders the menu outside the pane header, with every item reachable', () => {
    mount();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    expect(host.querySelector('.ck-pane-head')!.contains(menu)).toBe(false);
    expect(menu.className).toContain('ck-menu--float');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['Transcript', 'Receipt', 'Hand off']);
  });

  it('picking a view or a folded action closes the menu and runs it', () => {
    const { onPick, onSelect } = mount();
    act(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][1].click());
    expect(onPick).toHaveBeenCalledWith('receipt');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    act(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][2].click());
    expect(onSelect).toHaveBeenCalled();
  });

  it('keys: opening focuses the first item, Down moves, Escape closes and returns focus to the button', () => {
    mount();
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    act(() => {
      items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('button[aria-haspopup="menu"]'));
  });

  it('a press outside closes it', () => {
    mount();
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
