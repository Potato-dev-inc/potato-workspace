// @vitest-environment jsdom
// The title of a phone chat opens a small menu (switch view, close chat) through the shared Menu: it sits under the title,
// Up/Down move between its items, Escape closes it and gives the focus back to the title.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { PhoneHeader } from './PhoneHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const title = () => host.querySelector<HTMLButtonElement>('.ph-head-title')!;
const menu = () => document.querySelector<HTMLElement>('[data-testid="phone-peek"]');
const key = (name: string) => act(() => void document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })));

function renderHeader() {
  const peek = { view: 'chat' as const, canSwitch: true, onView: vi.fn(), onClose: vi.fn() };
  act(() =>
    root.render(
      <PhoneHeader title="Fix pairing check" agent={{ id: 'claude', name: 'Claude' }} waiting={0} bridgeReady onMenu={() => undefined} onNew={() => undefined} peek={peek} />,
    ),
  );
  return peek;
}

describe('the chat title menu', () => {
  it('opens a menu with the view switch and Close chat, and the first item takes the focus', () => {
    renderHeader();
    expect(menu()).toBeNull();
    act(() => title().click());
    expect(menu()).not.toBeNull();
    expect(menu()!.getAttribute('role')).toBe('menu');
    expect(menu()!.textContent).toContain('Close chat');
    expect(document.activeElement?.textContent).toBe('Show terminal');
  });

  it('Up and Down move between the items', () => {
    renderHeader();
    act(() => title().click());
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Close chat');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Show terminal');
  });

  it('Escape closes it and gives the focus back to the title', () => {
    renderHeader();
    act(() => title().click());
    key('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(title());
  });
});
