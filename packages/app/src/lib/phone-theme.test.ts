// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPhoneTheme, parsePhoneTheme, readPhoneTheme, resolvePhoneTheme, setPhoneTheme } from './phone-theme';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('phone theme', () => {
  it('an unknown value is Auto', () => {
    expect(parsePhoneTheme('blue')).toBe('auto');
    expect(parsePhoneTheme(null)).toBe('auto');
    expect(readPhoneTheme()).toBe('auto');
  });
  it('Auto follows the phone, Light and Dark do not', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(resolvePhoneTheme('auto')).toBe('light');
    expect(resolvePhoneTheme('dark')).toBe('dark');
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(resolvePhoneTheme('auto')).toBe('dark');
    expect(resolvePhoneTheme('light')).toBe('light');
  });
  it('apply sets data-theme, the dark class and the browser bar colour', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#000">';
    applyPhoneTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#fdfcfa');
    applyPhoneTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
  it('set keeps the choice and tells the page', () => {
    const seen = vi.fn();
    window.addEventListener('potato:phone-theme', seen);
    setPhoneTheme('light');
    expect(readPhoneTheme()).toBe('light');
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('potato:phone-theme', seen);
  });
  it('a phone that cannot say its setting gets Dark', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no');
    });
    expect(resolvePhoneTheme('auto')).toBe('dark');
  });
});
