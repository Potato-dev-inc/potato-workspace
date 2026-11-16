// @vitest-environment jsdom
// The pane's right-click menu is the shared Menu: it opens at the pointer, the arrows move, Home and End jump to the ends,
// Escape closes it and asks for the focus back, and a press outside closes it without asking.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { PaneContextMenu } from './PaneContextMenu';

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

const menu = () => document.querySelector<HTMLElement>('.fl-layer[role="menu"]');
const items = () => [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const key = (name: string) => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));

function renderMenu(onClose = vi.fn()) {
  act(() =>
    root.render(
      <PaneContextMenu x={120} y={140} onAction={vi.fn()} onInterrupt={vi.fn()} onClose={onClose} onPin={vi.fn()} pinned={false} />,
    ),
  );
  return onClose;
}

describe('the pane right-click menu', () => {
  it('opens with the first item focused and the items in order', () => {
    renderMenu();
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(items()[0]);
    expect(items().map((i) => i.textContent)).toContain('Rename');
  });

  it('ArrowDown and ArrowUp move between the items; End and Home jump to the ends', () => {
    renderMenu();
    key('ArrowDown');
    expect(document.activeElement).toBe(items()[1]);
    key('ArrowUp');
    expect(document.activeElement).toBe(items()[0]);
    key('End');
    expect(document.activeElement).toBe(items()[items().length - 1]);
    key('Home');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('Escape closes it and says the focus should go back', () => {
    const onClose = renderMenu();
    key('Escape');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('a press outside closes it without asking for the focus back', () => {
    const onClose = renderMenu();
    act(() => void document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
