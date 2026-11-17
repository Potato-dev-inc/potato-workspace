import { describe, expect, it } from 'vitest';
import { pacedBehind, pacedNext, pacedSlice } from './phone-paced-text';

const WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ').slice(0, 300);

describe('pacedNext', () => {
  it('moves forward, never back, never past the end', () => {
    let shown = 0;
    let prev = -1;
    for (let i = 0; i < 400 && shown < WORDS.length; i++) {
      shown = pacedNext(shown, WORDS);
      expect(shown).toBeGreaterThan(prev);
      expect(shown).toBeLessThanOrEqual(WORDS.length);
      prev = shown;
    }
    expect(shown).toBe(WORDS.length);
  });
  it('does not show a 300-letter jump in one tick, but is out in about a second (40 ticks of 24 ms)', () => {
    const one = pacedNext(0, WORDS);
    expect(one).toBeLessThan(60);
    let shown = 0;
    let ticks = 0;
    while (shown < WORDS.length) { shown = pacedNext(shown, WORDS); ticks++; }
    expect(ticks).toBeLessThanOrEqual(80);
  });
  it('cuts after a space when one is close', () => {
    const cut = pacedNext(0, 'abcde fghij klmno pqrst uvwxy abcde fghij klmno pqrst uvwxy abcde fghij klmno pqrst');
    expect(cut).toBe(6);
  });
  it('shows a small backlog at least two letters at a time, and clamps odd input', () => {
    expect(pacedNext(0, 'abcdef')).toBe(2);expect(pacedNext(4, 'abcdef')).toBe(6);
    expect(pacedNext(100, 'abc')).toBe(3);
    expect(pacedNext(-5, 'abcdef ghijklmnopqrstuvwxyz')).toBeGreaterThan(0);
  });
});

describe('pacedSlice / pacedBehind', () => {
  it('shows all when not active', () => {
    expect(pacedSlice('hello world', 2, false)).toBe('hello world');
    expect(pacedSlice('hello world', 5, true)).toBe('hello');
    expect(pacedBehind(5, 'hello world')).toBe(true);
    expect(pacedBehind(11, 'hello world')).toBe(false);
  });
});
