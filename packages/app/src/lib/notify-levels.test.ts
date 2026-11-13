import { describe, expect, it } from 'vitest';
import { decideAlert, defaultBellLevel, inQuietHours, isSnoozed, levelWants, parseBellLevel, QUIET_OFF, snoozeUntil, SNOOZE_MS } from './notify-levels';

const NOW = 1_000_000;
const base = { level: 'everything' as const, quiet: QUIET_OFF, minuteOfDay: 12 * 60, now: NOW };

describe('bell levels', () => {
  it('a helper starts at "needs me", a plain agent at everything', () => {
    expect(defaultBellLevel(true)).toBe('needs');
    expect(defaultBellLevel(false)).toBe('everything');
  });

  it('parses only the four known levels', () => {
    expect(parseBellLevel('finished')).toBe('finished');
    expect(parseBellLevel('loud')).toBeNull();
    expect(parseBellLevel(3)).toBeNull();
  });

  it('everything wants every event', () => {
    expect(levelWants('everything', 'question')).toBe(true);
    expect(levelWants('everything', 'done')).toBe(true);
  });

  it('needs me wants blocking cards but not a finished run or an Ask-bar answer', () => {
    expect(levelWants('needs', 'approval')).toBe(true);
    expect(levelWants('needs', 'error')).toBe(true);
    expect(levelWants('needs', 'done')).toBe(false);
    expect(levelWants('needs', 'answer')).toBe(false);
  });

  it('finished wants only a finished run', () => {
    expect(levelWants('finished', 'done')).toBe(true);
    expect(levelWants('finished', 'question')).toBe(false);
  });

  it('silent wants nothing', () => {
    expect(levelWants('silent', 'done')).toBe(false);
    expect(levelWants('silent', 'question')).toBe(false);
  });
});

describe('quiet hours', () => {
  it('off means never quiet', () => {
    expect(inQuietHours(3 * 60, QUIET_OFF)).toBe(false);
  });

  it('a window that crosses midnight covers 23:00 and 06:00 but not noon', () => {
    const q = { enabled: true, start: 22 * 60, end: 7 * 60 };
    expect(inQuietHours(23 * 60, q)).toBe(true);
    expect(inQuietHours(6 * 60, q)).toBe(true);
    expect(inQuietHours(12 * 60, q)).toBe(false);
    expect(inQuietHours(7 * 60, q)).toBe(false);
  });

  it('a window inside one day works too', () => {
    const q = { enabled: true, start: 13 * 60, end: 14 * 60 };
    expect(inQuietHours(13 * 60 + 30, q)).toBe(true);
    expect(inQuietHours(14 * 60, q)).toBe(false);
  });

  it('start equal to end means no quiet time', () => {
    expect(inQuietHours(5 * 60, { enabled: true, start: 5 * 60, end: 5 * 60 })).toBe(false);
  });
});

describe('snooze', () => {
  it('lasts 30 minutes from the moment it is set', () => {
    expect(SNOOZE_MS).toBe(30 * 60_000);
    expect(snoozeUntil(NOW)).toBe(NOW + SNOOZE_MS);
    expect(isSnoozed(snoozeUntil(NOW), NOW + SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(snoozeUntil(NOW), NOW + SNOOZE_MS)).toBe(false);
    expect(isSnoozed(null, NOW)).toBe(false);
  });
});

describe('decideAlert', () => {
  it('a normal question notifies at everything', () => {
    expect(decideAlert({ kind: 'question' }, base)).toEqual({ notify: true, reason: 'shown' });
  });

  it('a high-risk approval notifies even when silent, in quiet hours and snoozed', () => {
    const quiet = { enabled: true, start: 0, end: 23 * 60 + 59 };
    const d = decideAlert({ kind: 'approval', risk: 'high' }, { ...base, level: 'silent', quiet, snoozedUntil: NOW + 1000 });
    expect(d).toEqual({ notify: true, reason: 'risky' });
  });

  it('a consent card is never silenced', () => {
    expect(decideAlert({ kind: 'consent' }, { ...base, level: 'silent' })).toEqual({ notify: true, reason: 'risky' });
  });

  it('a low-risk approval obeys silent', () => {
    expect(decideAlert({ kind: 'approval', risk: 'low' }, { ...base, level: 'silent' })).toEqual({ notify: false, reason: 'level' });
  });

  it('quiet hours stop an ordinary alert', () => {
    const quiet = { enabled: true, start: 22 * 60, end: 7 * 60 };
    expect(decideAlert({ kind: 'question' }, { ...base, quiet, minuteOfDay: 23 * 60 })).toEqual({ notify: false, reason: 'quiet_hours' });
  });

  it('a snoozed card is quiet until the snooze ends', () => {
    const snoozedUntil = snoozeUntil(NOW);
    expect(decideAlert({ kind: 'question' }, { ...base, snoozedUntil })).toEqual({ notify: false, reason: 'snoozed' });
    expect(decideAlert({ kind: 'question' }, { ...base, snoozedUntil, now: snoozedUntil })).toEqual({ notify: true, reason: 'shown' });
  });

  it('the level is checked before quiet hours and snooze', () => {
    expect(decideAlert({ kind: 'done' }, { ...base, level: 'needs' })).toEqual({ notify: false, reason: 'level' });
  });
});
