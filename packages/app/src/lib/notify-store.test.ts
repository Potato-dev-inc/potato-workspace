import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BELL_KEY, levelFor, QUIET_KEY, readBells, readQuiet, writeBell, writeQuiet } from './notify-store';
import { QUIET_OFF } from './notify-levels';

// Node has no localStorage: a tiny in-memory one stands in for each test.
function fakeStorage(broken = false) {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (broken) throw new Error('blocked');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
    _data: data,
  };
}

const g = globalThis as unknown as { localStorage?: unknown };

describe('notification store', () => {
  let storage: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    storage = fakeStorage();
    g.localStorage = storage;
  });
  afterEach(() => {
    delete g.localStorage;
  });

  it('remembers one level per agent and falls back to the default', () => {
    expect(levelFor('codex', false)).toBe('everything');
    expect(levelFor('helper-x', true)).toBe('needs');
    writeBell('codex', 'finished');
    expect(readBells()).toEqual({ codex: 'finished' });
    expect(levelFor('codex', false)).toBe('finished');
    expect(levelFor('claude', false)).toBe('everything');
  });

  it('drops a stored value that is not a level', () => {
    storage._data.set(BELL_KEY, JSON.stringify({ codex: 'loud', claude: 'silent' }));
    expect(readBells()).toEqual({ claude: 'silent' });
  });

  it('a broken or unparsable store reads as the defaults and never throws', () => {
    storage._data.set(BELL_KEY, '{not json');
    expect(readBells()).toEqual({});
    storage._data.set(QUIET_KEY, '{not json');
    expect(readQuiet()).toEqual(QUIET_OFF);
  });

  it('a blocked store does not throw on write', () => {
    g.localStorage = fakeStorage(true);
    expect(() => writeBell('codex', 'silent')).not.toThrow();
    expect(() => writeQuiet({ enabled: true, start: 1, end: 2 })).not.toThrow();
    expect(readQuiet()).toEqual(QUIET_OFF);
  });

  it('round-trips quiet hours and rejects out-of-range minutes', () => {
    writeQuiet({ enabled: true, start: 22 * 60, end: 7 * 60 });
    expect(readQuiet()).toEqual({ enabled: true, start: 22 * 60, end: 7 * 60 });
    storage._data.set(QUIET_KEY, JSON.stringify({ enabled: true, start: 99999, end: -4 }));
    expect(readQuiet()).toEqual({ enabled: true, start: QUIET_OFF.start, end: QUIET_OFF.end });
  });
});
