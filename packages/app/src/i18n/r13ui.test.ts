// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { zhTW } from './zh-TW';
import { setLanguagePref } from './index';
import { useEnglish } from './test-utils';
import { shortcutTaken } from '../components/settings/sections/ShortcutsSection';
import { localizeExportPreview } from '../lib/chatExportPreview';

afterEach(() => useEnglish());

describe('run 13 zh-TW leftovers', () => {
  it('the catalogs have the same keys (the "_one" twins too)', () => {
    expect(Object.keys(en).filter((k) => !(k in zhTW))).toEqual([]);
  });
  it('a shortcut conflict names the keys for this computer, in the language of the app', () => {
    setLanguagePref('zh-TW', false);
    const line = shortcutTaken('Mod+Alt+M is already used by another app or by Windows. Pick another combination.');
    expect(line).toContain('Ctrl+Alt+M');
    expect(line).not.toMatch(/Mod|Pick another/);
    expect(shortcutTaken('something else')).toBe('something else');
  });
  it('the save preview says how long the turn took in Chinese', () => {
    setLanguagePref('zh-TW', false);
    expect(localizeExportPreview('_Done · 1 s_', 'markdown')).not.toMatch(/Done|\bs\b/);
  });
});
