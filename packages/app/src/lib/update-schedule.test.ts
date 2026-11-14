// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { QUIET_OFF } from './notify-levels';
import { dueToInstall, forgetWhatsNew, rememberWhatsNew, takeWhatsNew, tonightTarget, whatsNewLines, WHATS_NEW_KEY } from './update-schedule';

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m, 0, 0).getTime();

afterEach(() => forgetWhatsNew());

describe('Tonight', () => {
  it('is 02:00 when quiet hours are off, today if it is still ahead, else tomorrow', () => {
    expect(tonightTarget(at(14, 0, 30), QUIET_OFF)).toBe(at(14, 2));
    expect(tonightTarget(at(14, 22), QUIET_OFF)).toBe(at(15, 2));
    expect(tonightTarget(at(14, 2), null)).toBe(at(15, 2));
  });

  it('is the start of quiet hours when they are on', () => {
    const quiet = { enabled: true, start: 22 * 60 + 30, end: 7 * 60 };
    expect(tonightTarget(at(14, 15), quiet)).toBe(at(14, 22, 30));
    expect(tonightTarget(at(14, 23), quiet)).toBe(at(15, 22, 30));
  });

  it('is always in the future', () => {
    for (const hour of [0, 1, 2, 3, 12, 23]) expect(tonightTarget(at(14, hour), QUIET_OFF)).toBeGreaterThan(at(14, hour));
  });
});

describe('dueToInstall', () => {
  it('never while an agent works, whatever the choice', () => {
    expect(dueToInstall('finish', at(14, 12), null, 1)).toBe(false);
    expect(dueToInstall('tonight', at(15, 3), at(15, 2), 2)).toBe(false);
  });
  it('When they finish: as soon as nobody works', () => {
    expect(dueToInstall('finish', at(14, 12), null, 0)).toBe(true);
  });
  it('Tonight: only from the target time on', () => {
    expect(dueToInstall('tonight', at(14, 23), at(15, 2), 0)).toBe(false);
    expect(dueToInstall('tonight', at(15, 2), at(15, 2), 0)).toBe(true);
    expect(dueToInstall('tonight', at(15, 2), null, 0)).toBe(false);
  });
});

describe('What is new', () => {
  it('is returned once for the version that was installed, then gone', () => {
    rememberWhatsNew({ version: '1.0.3', notes: '- a\n- b', chats: 2 });
    expect(takeWhatsNew('1.0.3')).toEqual({ version: '1.0.3', notes: '- a\n- b', chats: 2 });
    expect(takeWhatsNew('1.0.3')).toBeNull();
  });
  it('matches a leading v and keeps the note for a different running version', () => {
    rememberWhatsNew({ version: 'v1.0.3', notes: null, chats: 0 });
    expect(takeWhatsNew('1.0.2')).toBeNull();
    expect(window.localStorage.getItem(WHATS_NEW_KEY)).not.toBeNull();
    expect(takeWhatsNew('1.0.3')?.version).toBe('v1.0.3');
  });
  it('an unknown running version or a broken note shows nothing and does not throw', () => {
    rememberWhatsNew({ version: '1.0.3', notes: null, chats: 0 });
    expect(takeWhatsNew(null)).toBeNull();
    window.localStorage.setItem(WHATS_NEW_KEY, '{not json');
    expect(takeWhatsNew('1.0.3')).toBeNull();
  });
  it('the lines are at most three, without bullets or markup, and long ones are cut', () => {
    const notes = '# 1.0.3\n\n- **Chats** come back\n* second\n1. third\n- fourth\n';
    expect(whatsNewLines(notes)).toEqual(['1.0.3', 'Chats come back', 'second']);
    expect(whatsNewLines('x'.repeat(300))[0].length).toBe(140);
    expect(whatsNewLines(null)).toEqual([]);
  });
});
