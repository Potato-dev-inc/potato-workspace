// The word "helper" is retired from what people read (minions plan section 4). This guard fails when an English value
// (base text, or the Two types overlay) uses it again, unless the key is on the short allow-list below with a reason.
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { twoTypesEn } from './en/twoTypes';
import { zhTW } from './zh-TW';
import { twoTypesZh } from './zh-TW/twoTypes';

const WORD = /\bhelpers?\b/i;

/**
 * Keys whose English value may still say "helper", and why. Keep this list short; add a line only with a reason.
 * Empty is the goal: the rename removed every use from what people read.
 */
export const HELPER_WORD_ALLOW: Readonly<Record<string, string>> = {};

/** English values that use the word, outside the allow-list. */
export function helperWordViolations(table: Partial<Record<string, string>>, allow: Readonly<Record<string, string>> = HELPER_WORD_ALLOW): string[] {
  return Object.entries(table)
    .filter(([key, value]) => typeof value === 'string' && WORD.test(value) && !(key in allow))
    .map(([key, value]) => `${key}: ${value}`);
}

describe('the word "helper" is not shown to people in English', () => {
  it('no English base value uses it (outside the allow-list)', () => {
    const found = helperWordViolations(en);
    expect(found, `rename these (minions plan section 4):\n${found.join('\n')}`).toEqual([]);
  });

  it('no Two types overlay value uses it either', () => {
    const found = helperWordViolations(twoTypesEn);
    expect(found, `rename these in en/twoTypes.ts:\n${found.join('\n')}`).toEqual([]);
  });

  it('the allow-list only names keys that exist, each with a reason', () => {
    for (const [key, reason] of Object.entries(HELPER_WORD_ALLOW)) {
      expect(key in en, `allow-list key ${key} is not an English key`).toBe(true);
      expect(reason.length, `allow-list entry ${key} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('the checker itself finds the word and respects the allow-list', () => {
    expect(helperWordViolations({ a: 'A helper runs' })).toHaveLength(1);
    expect(helperWordViolations({ a: 'Helpers run' })).toHaveLength(1);
    expect(helperWordViolations({ a: 'Standbys run' })).toHaveLength(0);
    expect(helperWordViolations({ a: 'A helper runs' }, { a: 'a test fixture for the checker itself' })).toHaveLength(0);
  });
});

describe('the word 幫手 is not shown to people in Traditional Chinese', () => {
  it('no zh-TW value uses it (the app says 小代理, 分支對話 or 待命代理)', () => {
    const found = Object.entries(zhTW as Record<string, string>).filter(([, v]) => typeof v === 'string' && v.includes('幫手')).map(([k, v]) => `${k}: ${v}`);
    expect(found).toEqual([]);
  });
});

describe('the Two types overlay', () => {
  it('every overlay key is a real key in both languages (so the switch never adds a stray text)', () => {
    for (const key of Object.keys(twoTypesEn)) {
      expect(key in en, `en is missing ${key}`).toBe(true);
    }
    for (const key of Object.keys(twoTypesZh)) {
      expect(key in zhTW, `zh-TW is missing ${key}`).toBe(true);
    }
  });

  it('overlay keys match between English and Chinese', () => {
    expect(Object.keys(twoTypesZh).sort()).toEqual(Object.keys(twoTypesEn).sort());
  });
});
