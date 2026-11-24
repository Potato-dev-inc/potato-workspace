import { describe, expect, it } from 'vitest';
import { setLanguagePref, setSystemLanguageForTests, t } from '../i18n';
import { turnSentence } from './turn-sentence';

const say = (lang: 'en' | 'zh-TW', s: string) => {
  setSystemLanguageForTests(null);
  setLanguagePref(lang, false);
  return turnSentence(t, s);
};
describe('turnSentence', () => {
  it('the review list wins over "made no file changes"', () => {
    setSystemLanguageForTests(null);
    setLanguagePref('en', false);
    expect(turnSentence(t, 'Claude made no file changes, now idle.', 1)).toBe('Claude changed 1 file, now idle.');
    expect(turnSentence(t, 'Claude made no file changes, now idle.', 0)).toBe('Claude made no file changes, now idle.');
  });
  it('leaves English as it came', () => {
    for (const s of ['Claude worked for 6s, now idle.', 'Claude edited 3 files (+48 −7), all checks passed (3/3), now idle.', 'Claude edited 1 file (+1 −0), you approved 1 command, now waiting: allow `npm test`?']) expect(say('en', s)).toBe(s);
  });
  it('translates each known part in zh-TW', () => {
    expect(say('zh-TW', 'Codex CLI worked for 0s, now waiting for you.')).toBe('Codex CLI 工作了 0 秒，現在等你處理。');
    expect(say('zh-TW', 'Claude edited 3 files (+48 −7), all checks passed (3/3), now idle.')).toBe('Claude 編輯了 3 個檔案（+48 −7），所有檢查都通過（3/3），現在閒置。');
    expect(say('zh-TW', 'Claude made no file changes, now waiting: allow it?')).toBe('Claude 沒有改動檔案，現在等待：allow it?');
  });
});
