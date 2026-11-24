import { afterEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { endingText } from './chatFormat';

describe('endingText', () => {
  afterEach(() => setLanguagePref('en'));
  it('keeps English and translates the backend done line in zh-TW', () => {
    expect(endingText('Done · 1 s')).toBe('Done · 1 s');
    setLanguagePref('zh-TW');
    expect(endingText('Done · 1 s')).toBe('完成 · 1 秒');
    expect(endingText('Done · 3 files · 1 h 5 min')).toBe('完成 · 3 個檔案 · 1 小時 5 分鐘');
    expect(endingText('You stopped it')).toBe('你已停止');
    expect(endingText('Something went wrong: x')).toBe('Something went wrong: x');
  });
  it('translates the other fixed endings and the far "file is gone" error in zh-TW', async () => {
    setLanguagePref('zh-TW');
    expect(endingText('Probably signed out')).toBe('可能已登出');
    expect(endingText('No answer for 3 min')).toBe('已 3 分鐘沒有回應');
    expect(endingText('Claude hit its usage limit')).toBe('Claude 已達使用上限');
    const { errorSentence } = await import('../../lib/sayError');
    expect(errorSentence('FILES_NOT_FOUND: That file is not there any more.')).toBe('這個檔案已經不在了。');
  });
  it('says a missing sign-in variable as a setup line with the Sign in reason', async () => {
    const { CODEX_UNSET } = await import('../../lib/sessionChatModel');
    expect(endingText(CODEX_UNSET)).toBe("Codex isn't set up on this PC yet");
    setLanguagePref('zh-TW');
    expect(endingText(CODEX_UNSET)).toBe('這台電腦還沒設定好 Codex');
  });
});
