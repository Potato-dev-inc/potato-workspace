// @vitest-environment jsdom
// The one closing rule for dropdowns: outside press, Escape, focus leaving, window blur, page scroll. The harness
// proves each reason; the screen-level tests (NewAgentPage.dismiss.test.tsx) prove the real pickers use it.
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDismissable } from './useDismissable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ reasons }: { reasons: string[] }) {
  const [open, setOpen] = useState(true);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissable(open, {
    inside: [menu, button],
    anchor: button,
    onDismiss: (why) => {
      reasons.push(why);
      setOpen(false);
    },
  });
  return (
    <div id="scroller">
      <button ref={button} id="anchor">
        open
      </button>
      {open && (
        <div ref={menu} id="menu" tabIndex={-1}>
          <button id="item">item</button>
          <div id="list" />
        </div>
      )}
      <button id="elsewhere">elsewhere</button>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
let reasons: string[];
beforeEach(async () => {
  reasons = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness reasons={reasons} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const fire = async (target: EventTarget, event: Event) => {
  await act(async () => {
    target.dispatchEvent(event);
  });
};
const find = (selector: string) => host.querySelector(selector) as HTMLElement;

describe('useDismissable', () => {
  it('closes on a press outside, even when something stops the event on its way up', async () => {
    find('#elsewhere').addEventListener('mousedown', (e) => e.stopPropagation());
    await fire(find('#elsewhere'), new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual(['outside']);
  });

  it('stays open for a press inside the menu or on the button that opened it', async () => {
    await fire(find('#item'), new MouseEvent('mousedown', { bubbles: true }));
    await fire(find('#anchor'), new MouseEvent('pointerdown', { bubbles: true }));
    expect(reasons).toEqual([]);
  });

  it('closes on Escape', async () => {
    await fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reasons).toEqual(['escape']);
  });

  it('closes when the focus moves outside, not when it moves inside', async () => {
    await fire(find('#item'), new FocusEvent('focusin', { bubbles: true }));
    expect(reasons).toEqual([]);
    await fire(find('#elsewhere'), new FocusEvent('focusin', { bubbles: true }));
    expect(reasons).toEqual(['focus']);
  });

  it('closes when the window loses focus (a click into an embedded page or another app)', async () => {
    await fire(window, new Event('blur'));
    expect(reasons).toEqual(['blur']);
  });

  it('closes when the page scrolls, but not when its own list scrolls', async () => {
    await fire(find('#list'), new Event('scroll'));
    expect(reasons).toEqual([]);
    await fire(document, new Event('scroll'));
    expect(reasons).toEqual(['scroll']);
  });

  it('closes when a scroll area that holds the button scrolls, not unrelated scrolling', async () => {
    const unrelated = document.createElement('div');
    document.body.appendChild(unrelated);
    await fire(unrelated, new Event('scroll'));
    expect(reasons).toEqual([]);
    await fire(find('#scroller'), new Event('scroll'));
    expect(reasons).toEqual(['scroll']);
    unrelated.remove();
  });

  it('does nothing once it is closed', async () => {
    await fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fire(document, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(reasons).toEqual(['escape']);
  });
});
