// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { menuShiftX, PaneMoreMenu } from './PaneMoreMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('menuShiftX (collision shift)', () => {
  it('leaves a menu that fits alone', () => {
    expect(menuShiftX(100, 320, 900)).toBe(0);
  });
  it('pulls a menu back in when it runs off the left edge', () => {
    expect(menuShiftX(-120, 100, 900)).toBe(128);
  });
  it('pulls a menu back in when it runs off the right edge', () => {
    expect(menuShiftX(700, 940, 900)).toBe(-48);
  });
  it('a menu wider than the window is pinned to the start edge', () => {
    expect(menuShiftX(-10, 400, 300)).toBe(18);
  });
});

describe('PaneMoreMenu placement', () => {
  let host: HTMLDivElement;
  let root: Root;
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
  const box = (left: number, right: number) => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) });
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    rect.mockReset();
  });
  const openMenu = () => {
    act(() =>
      root.render(
        createElement(PaneMoreMenu<'transcript' | 'receipt'>, {
          value: 'terminal',
          onPick: () => {},
          items: [
            { id: 'transcript', label: 'Transcript' },
            { id: 'receipt', label: 'Receipt' },
          ],
        }),
      ),
    );
    act(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
    return host.querySelector('[role="menu"]') as HTMLElement;
  };

  it('opens aligned to the start edge of its button (right-anchoring ran off the left of the window)', () => {
    expect(openMenu().classList.contains('ck-menu--start')).toBe(true);
  });

  it('slides back inside the window when it would overflow the left edge', () => {
    rect.mockReturnValue(box(-60, 160) as DOMRect);
    expect(openMenu().style.left).toBe('68px');
  });

  it('slides back inside the window when it would overflow the right edge', () => {
    rect.mockReturnValue(box(300, 520) as DOMRect);
    expect(openMenu().style.left).toBe('-128px');
  });

  it('adds no offset when it already fits', () => {
    rect.mockReturnValue(box(20, 240) as DOMRect);
    expect(openMenu().style.left).toBe('');
  });
});
