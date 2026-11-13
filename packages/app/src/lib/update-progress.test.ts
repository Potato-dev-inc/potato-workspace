import { describe, expect, it } from 'vitest';
import { downloadLine, megabytes, nextSpeed, secondsLeft } from './update-progress';

const MB = 1024 * 1024;

describe('update progress words', () => {
  it('sizes read as MB with one decimal under 100', () => {
    expect(megabytes(5.25 * MB)).toBe('5.3');
    expect(megabytes(138 * MB)).toBe('138');
  });

  it('speed is smoothed and never goes backwards on a reset', () => {
    const a = { downloaded: 0, at: 0 };
    const b = { downloaded: 4 * MB, at: 1000 };
    expect(nextSpeed(null, b, null)).toBeNull();
    expect(nextSpeed(a, b, null)).toBe(4 * MB);
    expect(nextSpeed(a, { downloaded: 8 * MB, at: 1000 }, 4 * MB)).toBeCloseTo(4 * MB * 0.6 + 8 * MB * 0.4);
    expect(nextSpeed(b, a, 3)).toBe(3);
  });

  it('time left needs a total and a speed', () => {
    expect(secondsLeft({ downloaded: 0, total: null, speed: 5 })).toBeNull();
    expect(secondsLeft({ downloaded: 0, total: 100, speed: null })).toBeNull();
    expect(secondsLeft({ downloaded: 40, total: 100, speed: 10 })).toBe(6);
  });

  it('the line leaves out what it does not know', () => {
    expect(downloadLine({ downloaded: 3 * MB, total: null, speed: null })).toBe('3.0 MB so far');
    expect(downloadLine({ downloaded: 40 * MB, total: 138 * MB, speed: 2 * MB })).toBe('40.0 MB of 138 MB · 2.0 MB/s · about 49 seconds left');
    expect(downloadLine({ downloaded: 10 * MB, total: 138 * MB, speed: 1 * MB })).toContain('about 3 minutes left');
  });
});
