import { describe, expect, it } from 'vitest';
import { en } from '../../../i18n/en';
import { zhTW } from '../../../i18n/zh-TW';
import { clock, folderName, formatWhen, noteText, stepText, whenText } from './routines-text';

// A tiny translate function over the real English messages.
const t = (key: string, vars: Record<string, string | number> = {}) => {
  const raw = (en as Record<string, string>)[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
};

describe('whenText', () => {
  it('says weekdays, every day, chosen days, chains and manual', () => {
    expect(whenText({ kind: 'routine', days: [1, 2, 3, 4, 5], time: '09:00', onlyIfOk: false }, t)).toBe('Weekdays at 09:00');
    expect(whenText({ kind: 'routine', days: [], time: '07:30', onlyIfOk: false }, t)).toBe('Every day at 07:30');
    expect(whenText({ kind: 'routine', days: [3, 1], time: '18:00', onlyIfOk: false }, t)).toBe('Mon, Wed at 18:00');
    expect(whenText({ kind: 'chain', days: [], time: null, onlyIfOk: true }, t)).toBe('When a chat finishes well');
    expect(whenText({ kind: 'chain', days: [], time: null, onlyIfOk: false }, t)).toBe('When a chat finishes');
    expect(whenText({ kind: 'manual', days: [], time: null, onlyIfOk: false }, t)).toBe('Only when you press Run now');
  });
});

describe('noteText', () => {
  it('words the late note with the due time and keeps an agent sentence', () => {
    const due = Date.UTC(2026, 10, 16, 9, 0, 0);
    expect(noteText({ noteCode: 'late', noteDetail: null, dueMs: due }, t, 'en')).toMatch(/^Ran late: your computer was off at \d\d:\d\d\.$/);
    expect(noteText({ noteCode: 'refused', noteDetail: 'That folder is not a project.', dueMs: null }, t, 'en')).toBe('It could not start. That folder is not a project.');
    expect(noteText({ noteCode: null, noteDetail: null, dueMs: null }, t, 'en')).toBe('');
    expect(noteText({ noteCode: 'surprise', noteDetail: null, dueMs: null }, t, 'en')).toBe('');
  });
});

describe('small helpers', () => {
  it('names a folder by its last part', () => {
    expect(folderName('C:\\work\\shop\\')).toBe('shop');
    expect(folderName('/home/me/app')).toBe('app');
  });
  it('writes a step in plain words', () => {
    expect(stepText({ kind: 'start_agent', agent: 'claude', project: 'C:/w/shop', text: 'x', separateCopy: true }, t, () => 'Claude Code')).toBe('Claude Code works in shop');
    expect(stepText({ kind: 'wait', agent: null, project: null, text: null, separateCopy: false }, t, (id) => id)).toBe('Wait for it to finish');
  });
  it('formats times', () => {
    expect(clock(Date.UTC(2026, 0, 1, 9, 5), 'en')).toMatch(/^\d\d:\d\d$/);
    expect(formatWhen(Date.now() + 3_600_000, 'en')).toMatch(/\d\d:\d\d/);
  });
});

describe('translations', () => {
  it('zh-TW has every routines key', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('routines.') || k === 'sidebar.routines');
    expect(keys.length).toBeGreaterThan(80);
    const missing = keys.filter((k) => !(zhTW as Record<string, string>)[k]);
    expect(missing).toEqual([]);
  });
});
