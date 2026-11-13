// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { menuShiftX } from './PaneMoreMenu';

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

