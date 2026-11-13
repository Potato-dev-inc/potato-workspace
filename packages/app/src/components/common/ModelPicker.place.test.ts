import { describe, expect, it } from 'vitest';
import { placeMenu } from './ModelPicker';

const view = { width: 1200, height: 800 };
describe('placeMenu', () => {
  it('opens below the chip when there is room', () => {
    const p = placeMenu({ left: 900, top: 100, bottom: 128, width: 200 }, view);
    expect(p.top).toBe(134);
    expect(p.bottom).toBeUndefined();
    expect(p.maxHeight).toBe(320);
  });
  it('flips above the chip near the bottom edge and scrolls inside', () => {
    const p = placeMenu({ left: 900, top: 740, bottom: 768, width: 200 }, view);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(66);
    expect(p.maxHeight).toBe(320);
  });
  it('keeps the menu inside the window sideways', () => {
    expect(placeMenu({ left: 1190, top: 100, bottom: 128, width: 20 }, view).left).toBe(1200 - 340 - 8);
  });
});
