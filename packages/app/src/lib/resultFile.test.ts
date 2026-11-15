import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { zhTW } from '../i18n/zh-TW';
import { devices as enDevices } from '../i18n/en/devices';
import { resultFileOf, safeRelativePath } from './resultFile';

const say = (text: string) => ({ kind: 'assistant', id: 'a', at: 1, text });

describe('resultFileOf', () => {
  it('finds the line in the last assistant message', () => {
    expect(resultFileOf([say('Done.\npotato-result: build/app.dmg')])).toBe('build/app.dmg');
    expect(resultFileOf([say('Done.\r\n  potato-result:   out/report.pdf  \r\n')])).toBe('out/report.pdf');
  });
  it('looks only at the last assistant message', () => {
    expect(resultFileOf([say('potato-result: old.txt'), { kind: 'user', text: 'again' }, say('Nothing this time.')])).toBeNull();
    expect(resultFileOf([say('potato-result: old.txt'), say('potato-result: new.txt')])).toBe('new.txt');
  });
  it('wants the line exactly, not inside other text', () => {
    expect(resultFileOf([say('see potato-result: a.txt')])).toBeNull();
    expect(resultFileOf([{ kind: 'user', text: 'potato-result: a.txt' }])).toBeNull();
    expect(resultFileOf('nope')).toBeNull();
    expect(resultFileOf([])).toBeNull();
  });
  it('rejects paths that leave the folder or are not paths', () => {
    for (const bad of ['../a.txt', 'a/../b.txt', '/etc/passwd', 'C:/x.txt', 'c:\\x.txt', 'a\\b.txt', '', '   ', 'a//b', './a', 'a/', 'x'.repeat(401)]) {
      expect(resultFileOf([say(`potato-result: ${bad}`)]), bad).toBeNull();
    }
    expect(safeRelativePath('x'.repeat(400))).toBe('x'.repeat(400));
  });
});

describe('Files words in zh-TW', () => {
  it('has every new devices key', () => {
    const keys = Object.keys(enDevices).filter((k) => /^devices\.(tab|perm\.files|folders|files|xfer|getit|act\.(in|out)\.(copied|sent))/.test(k));
    expect(keys.length).toBeGreaterThan(40);
    for (const k of keys) {
      expect((zhTW as Record<string, string>)[k], k).toBeTruthy();
      expect((en as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});
