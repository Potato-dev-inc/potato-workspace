// The local clock for "first result in under 3 minutes": starts, resumes, records once, stays on this machine.
import { describe, expect, it, vi } from 'vitest';
import { beginTiming, readTiming, recordFirstResult, TARGET_MS, TIMING_KEY } from './timing';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('first-run timing', () => {
  it('starts the clock, and records the first result once', () => {
    const store = memory();
    const log = vi.fn();
    beginTiming(1000, false, store);
    expect(recordFirstResult(61_000, store, log)).toBe(60_000);
    expect(readTiming(store)).toEqual({ startedAt: 1000, firstResultMs: 60_000 });
    expect(log).toHaveBeenCalledWith('[first-run] first result after 60s (within the 3 minute target)');
    expect(recordFirstResult(99_000, store, log)).toBeNull(); // only the first run counts
    expect(readTiming(store)!.firstResultMs).toBe(60_000);
  });

  it('says when the first result was over the target', () => {
    const store = memory();
    const log = vi.fn();
    beginTiming(0, false, store);
    recordFirstResult(TARGET_MS + 1000, store, log);
    expect(log.mock.calls[0][0]).toContain('over the 3 minute target');
  });

  it('a resumed welcome keeps its clock; a fresh one, or one that already finished, starts again', () => {
    const store = memory();
    beginTiming(1000, false, store);
    expect(beginTiming(5000, true, store).startedAt).toBe(1000);
    recordFirstResult(2000, store, () => undefined);
    expect(beginTiming(9000, true, store)).toEqual({ startedAt: 9000 });
    expect(beginTiming(12_000, false, store)).toEqual({ startedAt: 12_000 });
  });

  it('records nothing without a start, and survives blocked or broken storage', () => {
    expect(recordFirstResult(5, memory(), () => undefined)).toBeNull();
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTiming(broken)).toBeNull();
    expect(() => beginTiming(1, false, broken)).not.toThrow();
    const bad = memory();
    bad.setItem(TIMING_KEY, 'not json');
    expect(readTiming(bad)).toBeNull();
    expect(readTiming(null)).toBeNull();
  });
});
