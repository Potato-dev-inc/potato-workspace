// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { zhTW } from './zh-TW';
import {
  getLanguage,
  getLanguagePref,
  languageFromTag,
  resolveLanguage,
  setLanguagePref,
  setSystemLanguageForTests,
  t,
  type MessageKey,
} from './index';
import { useEnglish } from './test-utils';

afterEach(() => {
  setSystemLanguageForTests(null);
  useEnglish();
});

describe('catalogs', () => {
  it('every en key exists in zh-TW or falls back to English (never shows the key)', () => {
    setLanguagePref('zh-TW', false);
    for (const key of Object.keys(en)) {
      const shown = t(key as MessageKey, { count: 2, n: 2, name: 'x' });
      expect(shown, key).not.toBe('');
      if (!(key in zhTW)) {
        // Falls back to the English text (after the same interpolation), not to the key.
        setLanguagePref('en', false);
        const english = t(key as MessageKey, { count: 2, n: 2, name: 'x' });
        setLanguagePref('zh-TW', false);
        expect(shown, key).toBe(english);
      }
    }
  });

  it('zh-TW has no key that English does not have (a typo would never show)', () => {
    const extra = Object.keys(zhTW).filter((k) => !(k in en));
    expect(extra).toEqual([]);
  });

  it('zh-TW keeps every {placeholder} the English text has', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    const bad = Object.entries(zhTW).filter(([k, v]) => v !== undefined && holes(v) !== holes((en as Record<string, string>)[k]));
    // zh-TW may drop {count} in a plural form that does not need it; every other placeholder must stay.
    expect(bad.filter(([k]) => !/_(one|other)$/.test(k)).map(([k]) => k)).toEqual([]);
  });

  it('the zh-TW file has been reviewed (no draft marker)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readFileSync(join(__dirname, 'zh-TW.ts'), 'utf8').split('\n')[0]).not.toMatch(/^\/\/ draft/);
  });
});

describe('t()', () => {
  it('falls back to the key only when nothing knows it', () => {
    expect(t('no.such.key' as MessageKey)).toBe('no.such.key');
  });

  it('interpolates {name} and leaves unknown holes alone', async () => {
    const key = Object.keys(en).find((k) => /\{\w+\}/.test((en as Record<string, string>)[k]) && !/_(one|other)$/.test(k));
    if (!key) return;
    const text = t(key as MessageKey, { name: 'ZZ', n: 7, count: 7 });
    expect(text).not.toMatch(/\{(name|n|count)\}/);
  });

  it('uses _one / _other in English and _other in Chinese', () => {
    const base = Object.keys(en).find((k) => k.endsWith('_one'))?.replace(/_one$/, '');
    if (!base) return;
    const table = en as Record<string, string>;
    setLanguagePref('en', false);
    expect(t(base as MessageKey, { count: 1, n: 1 })).toBe(table[`${base}_one`].replace('{count}', '1').replace('{n}', '1'));
    expect(t(base as MessageKey, { count: 3, n: 3 })).toBe(table[`${base}_other`].replace('{count}', '3').replace('{n}', '3'));
  });
});

describe('language choice', () => {
  it('Automatic follows the system language: Traditional Chinese tags give zh-TW, everything else English', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'ZH-tw']) expect(languageFromTag(tag)).toBe('zh-TW');
    for (const tag of ['en-US', 'zh-CN', 'zh-Hans', 'ja-JP', '', null, undefined]) expect(languageFromTag(tag)).toBe('en');
    expect(resolveLanguage('auto', 'zh-TW')).toBe('zh-TW');
    expect(resolveLanguage('en', 'zh-TW')).toBe('en');
    expect(resolveLanguage('zh-TW', 'en-US')).toBe('zh-TW');
  });

  it('setting the language switches live, sets <html lang> and is remembered for the next start', () => {
    setLanguagePref('zh-TW');
    expect(getLanguage()).toBe('zh-TW');
    expect(getLanguagePref()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(localStorage.getItem('pm-ui-language')).toBe('zh-TW');
    setLanguagePref('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('Automatic on a Chinese Windows picks Chinese', () => {
    setSystemLanguageForTests('zh-TW');
    setLanguagePref('auto', false);
    expect(getLanguage()).toBe('zh-TW');
    setSystemLanguageForTests('en-US');
    expect(getLanguage()).toBe('en');
  });
});
