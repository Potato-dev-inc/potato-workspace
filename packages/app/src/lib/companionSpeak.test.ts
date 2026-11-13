import { describe, expect, it } from 'vitest';
import {
  COOL_DOWN_MS,
  LATER_MS,
  SPEAK_DEFAULTS,
  SPEAK_MEMORY_START,
  afterLater,
  afterShown,
  clampPerHour,
  halveBudget,
  minutesSince,
  parseSpeak,
  pickSpeak,
  silenceReason,
  type SpeakContext,
  type SpeakEvent,
  type SpeakSettings,
} from './companionSpeak';

const on: SpeakSettings = { ...SPEAK_DEFAULTS, on: true };
const now = 10_000_000;
const ctx: SpeakContext = { now, lastTypedAt: null, inQuietHours: false, asleep: false };
const waiting = (id: string, minutes: number): SpeakEvent => ({ key: `waiting:${id}`, kind: 'waiting', paneId: id, name: id, minutes, yesNo: true });

describe('companion speak rules', () => {
  it('is off by default', () => {
    expect(SPEAK_DEFAULTS.on).toBe(false);
    expect(pickSpeak(SPEAK_DEFAULTS, SPEAK_MEMORY_START, ctx, [waiting('a', 12)])).toBeNull();
    expect(silenceReason(SPEAK_DEFAULTS, SPEAK_MEMORY_START, ctx)).toBe('off');
  });

  it('speaks the longest wait first, then a usage warning, then a finished run', () => {
    const usage: SpeakEvent = { key: 'usage:x', kind: 'usage', name: 'Claude', percent: 90 };
    const done: SpeakEvent = { key: 'finished:z', kind: 'finished', name: 'z' };
    const pick = pickSpeak(on, SPEAK_MEMORY_START, ctx, [done, usage, waiting('a', 11), waiting('b', 30)]);
    expect(pick?.key).toBe('waiting:b');
    expect(pickSpeak(on, SPEAK_MEMORY_START, ctx, [done, usage])?.key).toBe('usage:x');
  });

  it('stays silent while the person types, in quiet hours and while asleep', () => {
    expect(pickSpeak(on, SPEAK_MEMORY_START, { ...ctx, lastTypedAt: now - 2000 }, [waiting('a', 12)])).toBeNull();
    expect(pickSpeak(on, SPEAK_MEMORY_START, { ...ctx, lastTypedAt: now - 60_000 }, [waiting('a', 12)])).not.toBeNull();
    expect(silenceReason(on, SPEAK_MEMORY_START, { ...ctx, inQuietHours: true })).toBe('quiet_hours');
    expect(silenceReason(on, SPEAK_MEMORY_START, { ...ctx, asleep: true })).toBe('asleep');
  });

  it('pauses after each bubble and stops at the hourly budget', () => {
    let memory = afterShown(SPEAK_MEMORY_START, waiting('a', 12), now);
    expect(silenceReason(on, memory, { ...ctx, now: now + COOL_DOWN_MS - 1 })).toBe('cool_down');
    let t = now;
    for (const id of ['b', 'c']) {
      t += COOL_DOWN_MS + 1;
      expect(silenceReason(on, memory, { ...ctx, now: t })).toBeNull();
      memory = afterShown(memory, waiting(id, 12), t);
    }
    t += COOL_DOWN_MS + 1;
    expect(silenceReason(on, memory, { ...ctx, now: t })).toBe('budget');
    // An hour after the first one, there is room again.
    expect(silenceReason(on, memory, { ...ctx, now: now + 60 * 60_000 + COOL_DOWN_MS })).toBeNull();
  });

  it('never says the same thing twice, and Later brings it back after a while', () => {
    const e = waiting('a', 12);
    const shown = afterShown(SPEAK_MEMORY_START, e, now);
    const later = now + COOL_DOWN_MS + 1;
    expect(pickSpeak(on, shown, { ...ctx, now: later }, [e])).toBeNull();
    const snoozed = afterLater(shown, e, later);
    expect(pickSpeak(on, snoozed, { ...ctx, now: later + LATER_MS - 1 }, [e])).toBeNull();
    expect(pickSpeak(on, snoozed, { ...ctx, now: later + LATER_MS + 1 }, [e])?.key).toBe(e.key);
  });

  it('Too much halves the budget and never goes below one', () => {
    expect(halveBudget(3)).toBe(1);
    expect(halveBudget(8)).toBe(4);
    expect(halveBudget(1)).toBe(1);
  });

  it('parses saved values safely', () => {
    expect(parseSpeak(null)).toEqual(SPEAK_DEFAULTS);
    expect(parseSpeak({ on: 'yes', perHour: 99 })).toEqual({ on: false, perHour: 12, offered: false });
    expect(clampPerHour(0)).toBe(1);
    expect(clampPerHour(NaN)).toBe(3);
    expect(minutesSince(now - 12 * 60_000 - 5000, now)).toBe(12);
  });
});
