// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { setLanguagePref } from '../i18n';
import { reasonText } from './review-reasons';

describe('reasonText', () => {
  it('keeps English as it came and an unknown sentence as it came', () => {
    setLanguagePref('en', false);
    expect(reasonText({ sentence: 'Big change: 31 files, +1,204 \u221288' })).toBe('Big change: 31 files, +1,204 \u221288');
    expect(reasonText({ sentence: 'Test files changed: a.test.ts and 2 more' })).toBe('Test files changed: a.test.ts and 2 more');
    expect(reasonText({ sentence: 'Something new' })).toBe('Something new');
  });
  it('translates the known sentences in zh-TW', () => {
    setLanguagePref('zh-TW', false);
    expect(reasonText({ sentence: 'Big change: 17 files, +10 \u22122' })).toBe('大幅變動：17 個檔案，+10 \u22122');
    expect(reasonText({ sentence: 'Test files changed: a.test.ts and 2 more' })).toBe('測試檔案有變動：a.test.ts，另外還有 2 個');
    expect(reasonText({ sentence: 'Checks failed: 3 of 5 passed (lint)' })).toBe('檢查未通過：5 項中通過 3 項 (lint)');
    setLanguagePref('en', false);
  });
});
