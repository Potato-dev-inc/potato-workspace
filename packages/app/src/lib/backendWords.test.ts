import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../i18n';
import { useEnglish } from '../i18n/test-utils';
import { backendText } from './backendWords';
import { turnTitle } from './turn-sentence';
import { t } from '../i18n';

afterEach(() => useEnglish());

describe('backendText', () => {
  it('keeps English text as it came', () => {
    expect(backendText('Installed.')).toBe('Installed.');
  });
  it('turns the Rust sentences into the app language and leaves unknown ones alone', () => {
    setLanguagePref('zh-TW', false);
    expect(backendText('Installed.')).toBe('已安裝。');
    expect(backendText('Counting Undo since 24 November 2026. Earlier undos were not recorded.')).toContain('2026年11月24日');
    expect(backendText('1 turn had no file information, so they add no files.')).toContain('1 個回合');
    expect(backendText('7 records could not be read. Their turns are not counted.')).toContain('7 筆紀錄');
    expect(backendText('something new')).toBe('something new');
  });
  it('translates a finished-turn title but not a title the agent wrote', () => {
    setLanguagePref('zh-TW', false);
    expect(turnTitle(t, 'OpenCode edited 7 files (+356 −83), now idle.')).toContain('7');
    expect(turnTitle(t, 'OpenCode edited 7 files (+356 −83), now idle.')).not.toContain('edited');
    expect(turnTitle(t, 'Make the cart total round to cents')).toBe('Make the cart total round to cents');
  });
});
