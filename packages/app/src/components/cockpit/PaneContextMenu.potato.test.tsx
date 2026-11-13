// @vitest-environment jsdom
// The row menu offers "Potato, check on this" only when a companion exists (the caller passes onPotato), and it is reachable by keyboard.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { PaneContextMenu } from './PaneContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLanguagePref('en', false);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('auto', false);
});

const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);

describe('PaneContextMenu: Potato', () => {
  it('has no Potato item without a companion', () => {
    act(() => root.render(<PaneContextMenu x={10} y={10} onAction={() => {}} onInterrupt={() => {}} onClose={() => {}} />));
    expect(items().join('|')).not.toContain('Potato');
  });

  it('shows the item and runs it', () => {
    const onPotato = vi.fn();
    act(() => root.render(<PaneContextMenu x={10} y={10} onPotato={onPotato} onAction={() => {}} onInterrupt={() => {}} onClose={() => {}} />));
    expect(items()).toContain('Potato, check on this');
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === 'Potato, check on this')!;
    act(() => item.click());
    expect(onPotato).toHaveBeenCalledTimes(1);
  });
});
