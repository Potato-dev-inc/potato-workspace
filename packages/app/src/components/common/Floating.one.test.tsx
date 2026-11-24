// @vitest-environment jsdom
// One popover at a time: a layer that opens closes the open one that is not its parent, even when no press came (a keyboard or screen-reader opener).
import { act, useState } from 'react';
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

describe('one popover at a time', () => {
  it('opening a second, unrelated menu closes the first', async () => {
    const closeA = vi.fn();
    function Two() {
      const [b, setB] = useState(false);
      return (
        <div>
          <Menu point={{ x: 5, y: 5 }} label="A" onClose={closeA}>
            <button role="menuitem">a</button>
          </Menu>
          <button data-testid="open-b" onClick={() => setB(true)} />
          {b && (
            <Menu point={{ x: 50, y: 50 }} label="B" onClose={() => setB(false)}>
              <button role="menuitem">b</button>
            </Menu>
          )}
        </div>
      );
    }
    await act(async () => root.render(<Two />));
    expect(closeA).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="open-b"]')!.click());
    expect(closeA).toHaveBeenCalled();
  });

  it('a menu opened from inside a card does not close the card', async () => {
    const closeCard = vi.fn();
    function Nested() {
      const [m, setM] = useState(false);
      return (
        <Popover point={{ x: 5, y: 5 }} label="Card" onClose={closeCard}>
          <button data-testid="inner" onClick={() => setM(true)} />
          {m && (
            <Menu point={{ x: 9, y: 9 }} label="M" onClose={() => setM(false)}>
              <button role="menuitem">m</button>
            </Menu>
          )}
        </Popover>
      );
    }
    await act(async () => root.render(<Nested />));
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="inner"]')!.click());
    expect(closeCard).not.toHaveBeenCalled();
  });
});
