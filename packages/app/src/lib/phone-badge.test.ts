// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAppBadgeCount } from './phone-badge';

afterEach(() => {
  delete (navigator as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as { clearAppBadge?: unknown }).clearAppBadge;
});

describe('app icon badge', () => {
  it('sets the number, and clears at zero', () => {
    const set = vi.fn(async () => undefined);
    const clear = vi.fn(async () => undefined);
    Object.assign(navigator, { setAppBadge: set, clearAppBadge: clear });
    setAppBadgeCount(3);
    expect(set).toHaveBeenCalledWith(3);
    setAppBadgeCount(0);
    expect(clear).toHaveBeenCalledTimes(1);
  });
  it('does nothing on a phone without the Badging API, and survives a refusal', () => {
    expect(() => setAppBadgeCount(2)).not.toThrow();
    Object.assign(navigator, { setAppBadge: () => Promise.reject(new Error('denied')) });
    expect(() => setAppBadgeCount(2)).not.toThrow();
  });
});
