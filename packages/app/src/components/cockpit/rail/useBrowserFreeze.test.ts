// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { overlayOverPage } from './useBrowserFreeze';

const PAGE = { x: 0, y: 0, width: 500, height: 500 };
const rectOf = (el: HTMLElement) => {
  el.getBoundingClientRect = () => ({ left: 10, top: 10, right: 200, bottom: 100, width: 190, height: 90, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
};
const mount = (html: string): HTMLElement => {
  const host = document.createElement('div');
  host.innerHTML = html;
  host.querySelectorAll<HTMLElement>('*').forEach(rectOf);
  return host;
};

describe('overlayOverPage', () => {
  it('ignores the update notice and toasts', () => {
    expect(overlayOverPage(PAGE, mount('<div class="app-update-notice" role="status">Update</div>'))).toBe(false);
    expect(overlayOverPage(PAGE, mount('<div class="ck-toasts"><div role="status">Saved</div></div>'))).toBe(false);
  });
  it('still freezes for a menu or a dialog', () => {
    expect(overlayOverPage(PAGE, mount('<div role="menu">x</div>'))).toBe(true);
    expect(overlayOverPage(PAGE, mount('<div role="dialog">x</div>'))).toBe(true);
  });
});
