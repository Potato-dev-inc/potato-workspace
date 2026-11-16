// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, Popover } from './Floating';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const press = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
const key = (name: string) => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));

/** A button that opens a card; the card holds a button that opens a menu (the Add helper + model menu shape). */
function Nested({ onParentClose, onChildClose }: { onParentClose?: () => void; onChildClose?: () => void }) {
  const [card, setCard] = useState(false);
  const [menu, setMenu] = useState(false);
  const open = useRef<HTMLButtonElement>(null);
  const inner = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ overflow: 'hidden' }}>
      <button ref={open} data-testid="open" onClick={() => setCard(true)}>
        open
      </button>
      {card && (
        <Popover anchorRef={open} label="Card" testId="card" onClose={() => (onParentClose?.(), setCard(false))}>
          <button ref={inner} data-testid="inner" onClick={() => setMenu(true)}>
            pick
          </button>
          {menu && (
            <Menu anchorRef={inner} align="start" label="Child" onClose={() => (onChildClose?.(), setMenu(false))}>
              <button role="menuitem" data-testid="item-a">
                A
              </button>
              <button role="menuitem" data-testid="item-b">
                B
              </button>
            </Menu>
          )}
        </Popover>
      )}
    </div>
  );
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const openBoth = () => {
  act(() => q('open')!.click());
  act(() => q('inner')!.click());
};

describe('Popover and Menu', () => {
  it('draw into the cockpit root, outside the clipping parent', () => {
    act(() => root.render(createElement(Nested)));
    openBoth();
    const card = q('card')!;
    expect(card.parentElement).toBe(host);
    expect(card.closest('[style*="overflow"]')).toBeNull();
    expect(card.classList.contains('fl-layer')).toBe(true);
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.parentElement).toBe(host);
  });

  it('a press inside the child menu does not close the parent card', () => {
    const parent = vi.fn();
    const child = vi.fn();
    act(() => root.render(createElement(Nested, { onParentClose: parent, onChildClose: child })));
    openBoth();
    press(q('item-a')!);
    expect(parent).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    // A press on the card (outside the child) closes only the child; a press elsewhere closes the card.
    press(q('card')!);
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
    press(document.body);
    expect(parent).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the innermost layer first and gives the focus back to its button', () => {
    const parent = vi.fn();
    const child = vi.fn();
    act(() => root.render(createElement(Nested, { onParentClose: parent, onChildClose: child })));
    openBoth();
    key('Escape');
    expect(child).toHaveBeenCalledTimes(1);
    expect(parent).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q('inner'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    key('Escape');
    expect(parent).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(q('open'));
  });

  it('a Menu focuses its first item and Up/Down move between items', () => {
    act(() => root.render(createElement(Nested)));
    openBoth();
    expect(document.activeElement).toBe(q('item-a'));
    act(() => void q('item-a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(q('item-b'));
    act(() => void q('item-b')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(q('item-a'));
    act(() => void q('item-a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(document.activeElement).toBe(q('item-b'));
  });

  it('sits under its anchor, lined up with it, and flips above when there is no room', () => {
    const rect = (top: number) => ({ left: 100, right: 160, top, bottom: top + 20, width: 60, height: 20, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;
    const sizes = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100);
    let top = 50;
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(top));
    Object.assign(window, { innerWidth: 1000, innerHeight: 700 });
    act(() => root.render(createElement(Nested)));
    act(() => q('open')!.click());
    expect(q('card')!.style.top).toBe('76px'); // anchor bottom 70 + gap 6
    expect(q('card')!.style.left).toBe('100px'); // start edge
    act(() => root.render(createElement('div')));
    top = 660;
    act(() => root.render(createElement(Nested)));
    act(() => q('open')!.click());
    expect(q('card')!.getAttribute('data-up')).toBe('true');
    expect(Number.parseInt(q('card')!.style.top, 10)).toBeLessThan(660);
    sizes.mockRestore();
    tall.mockRestore();
    spy.mockRestore();
  });

  it('a point anchor (a right-click) places the menu at that point', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(50);
    Object.assign(window, { innerWidth: 1000, innerHeight: 700 });
    act(() =>
      root.render(
        createElement(Menu, { point: { x: 300, y: 200 }, align: 'start', onClose: () => {}, label: 'Here', children: createElement('button', { role: 'menuitem' }, 'x') }),
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.left).toBe('300px');
    expect(menu.style.top).toBe('206px');
    vi.restoreAllMocks();
  });
});
