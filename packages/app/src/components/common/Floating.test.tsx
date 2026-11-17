// @vitest-environment jsdom
import { act, createElement, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOAT_EDGE, Menu, Popover, placeFloating } from './Floating';

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

  it('a capped list opened above its button ends right above it, not at the top of the window', () => {
    const rect = { left: 100, right: 200, top: 600, bottom: 620, width: 100, height: 20, x: 100, y: 600, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(260);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900); // the whole model list
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect);
    Object.assign(window, { innerWidth: 1000, innerHeight: 700 });
    function Capped() {
      const a = useRef<HTMLButtonElement>(null);
      return createElement('div', null, createElement('button', { ref: a }, 'Model'), createElement(Popover, { anchorRef: a, maxHeight: 320, testId: 'list', onClose: () => {}, children: 'x' }));
    }
    act(() => root.render(createElement(Capped)));
    const el = q('list')!;
    const top = Number.parseInt(el.style.top, 10);
    const h = Number.parseInt(el.style.maxHeight, 10);
    expect(h).toBe(320);
    expect(top + h).toBe(600 - 6); // its bottom sits one gap above the button
    expect(top).toBeGreaterThanOrEqual(8);
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

describe('placeFloating: never cut off', () => {
  const view = { width: 1280, height: 600 };
  const bottomAnchor = { left: 20, right: 44, top: 560, bottom: 584 };
  it('a menu taller than the space below opens above its anchor', () => {
    const p = placeFloating(bottomAnchor, { width: 220, height: 300 }, view, 'start', 'down');
    expect(p.up).toBe(true);
    expect(p.capped).toBe(false);
    expect(p.top + 300).toBeLessThanOrEqual(560);
    expect(p.top).toBeGreaterThanOrEqual(FLOAT_EDGE);
  });
  it('a menu taller than the whole window is cut to the room and scrolls, 8px from the edges', () => {
    const p = placeFloating(bottomAnchor, { width: 220, height: 900 }, view, 'start', 'up');
    expect(p.capped).toBe(true);
    expect(p.top).toBe(FLOAT_EDGE);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(560 - 6);
    expect(p.maxHeight).toBeLessThanOrEqual(view.height - 2 * FLOAT_EDGE);
  });
  it('a menu at the right edge is pulled back 8px inside', () => {
    const p = placeFloating({ left: 1270, right: 1280, top: 10, bottom: 30 }, { width: 220, height: 100 }, view, 'start');
    expect(p.left + 220).toBe(1280 - FLOAT_EDGE);
  });
});

describe('Menu on a scrolling window', () => {
  it('is cut to the window and scrolls when it is taller, and arrow keys scroll the item into view', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 10, right: 40, top: 560, bottom: 584, width: 30, height: 24, x: 10, y: 560, toJSON: () => ({}) }) as DOMRect,
    );
    Object.assign(window, { innerWidth: 1280, innerHeight: 600 });
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    act(() =>
      root.render(
        createElement(Menu, {
          anchorRef: { current: anchor },
          prefer: 'up',
          align: 'start',
          onClose: () => {},
          label: 'Tall',
          children: [createElement('button', { key: 'a', role: 'menuitem', 'data-testid': 'ta' }, 'A'), createElement('button', { key: 'b', role: 'menuitem', 'data-testid': 'tb' }, 'B')],
        }),
      ),
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu.style.overflowY).toBe('auto');
    expect(menu.style.top).toBe('8px');
    expect(Number.parseInt(menu.style.maxHeight, 10)).toBeLessThanOrEqual(546);
    act(() => void q('ta')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(into).toHaveBeenCalledWith({ block: 'nearest' });
    anchor.remove();
    vi.restoreAllMocks();
  });
});
