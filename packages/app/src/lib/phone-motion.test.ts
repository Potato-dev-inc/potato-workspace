// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_MOTION_KEY, SPRING, parsePhoneMotion, prefersReduced, readPhoneMotion, setPhoneMotion, springSettled, springValue, startSpring } from './phone-motion';

describe('spring maths', () => {
  it('starts at from and ends at to', () => {
    expect(springValue(0, 100, 0, 0.4)).toBeCloseTo(0, 6);
    expect(springValue(0, 100, 4, 0.4)).toBeCloseTo(100, 3);
  });
  it('never overshoots and only moves forward when it starts at rest', () => {
    for (const [from, to] of [[0, 100], [100, 0], [-50, 20]] as Array<[number, number]>) {
      let prev = from;
      for (let t = 0; t <= 2; t += 0.004) {
        const v = springValue(from, to, t, 0.4);
        if (to > from) { expect(v).toBeLessThanOrEqual(to + 1e-9); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); }
        else { expect(v).toBeGreaterThanOrEqual(to - 1e-9); expect(v).toBeLessThanOrEqual(prev + 1e-9); }
        prev = v;
      }
    }
  });
  it('has nearly arrived by its duration, and settles', () => {
    const o = SPRING.dock;
    expect(Math.abs(springValue(0, 100, o.duration, o.duration) - 100)).toBeLessThan(15);
    expect(springSettled(0, 100, 0.01, { duration: o.duration })).toBe(false);
    expect(springSettled(0, 100, o.duration * 2, { duration: o.duration })).toBe(true);
    expect(springSettled(0, 100, o.duration * 5, { duration: o.duration, rest: 0 })).toBe(true);
  });
  it('keeps the finger speed: a flick toward the end gets there sooner, without passing it by more than a hair', () => {
    const slow = springValue(0, 1, 0.1, 0.34, 0);
    const fast = springValue(0, 1, 0.1, 0.34, 6);
    expect(fast).toBeGreaterThan(slow);
    let max = 0;
    for (let t = 0; t < 1.5; t += 0.004) max = Math.max(max, springValue(0, 1, t, 0.34, 6));
    expect(max).toBeLessThan(1.05);
  });
});

describe('startSpring', () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('runs on frames, settles on the end value and calls done once', () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => { now += 16; cb(now); }, 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const seen: number[] = [];
    const done = vi.fn();
    startSpring(0, 100, { duration: 0.4 }, (v) => seen.push(v), done, false);
    vi.advanceTimersByTime(3000);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[seen.length - 1]).toBe(100);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    expect(done).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it('under reduced motion paints the end at once', () => {
    const seen: number[] = [];
    const done = vi.fn();
    startSpring(0, 100, { duration: 0.4 }, (v) => seen.push(v), done, true);
    expect(seen).toEqual([100]);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('stop() ends it without painting more', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    const paint = vi.fn();
    const run = startSpring(0, 100, { duration: 0.4 }, paint, undefined, false);
    run.stop();
    vi.advanceTimersByTime(1000);
    expect(paint).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('Full / Reduced choice', () => {
  beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });
  it('is Full unless Reduced was saved', () => {
    expect(parsePhoneMotion('whatever')).toBe('full');
    expect(readPhoneMotion()).toBe('full');
    setPhoneMotion('reduce');
    expect(localStorage.getItem(PHONE_MOTION_KEY)).toBe('reduce');
    expect(readPhoneMotion()).toBe('reduce');
  });
  it('prefersReduced reads the shell mark, else the saved choice', () => {
    expect(prefersReduced()).toBe(false);
    setPhoneMotion('reduce');
    expect(prefersReduced()).toBe(true);
    localStorage.clear();
    document.body.innerHTML = '<div class="ph" data-motion="reduce"><i id="x"></i></div>';
    expect(prefersReduced(document.getElementById('x'))).toBe(true);
  });
});
