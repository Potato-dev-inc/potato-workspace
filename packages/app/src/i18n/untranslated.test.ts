// @vitest-environment node
// A zh-TW value that is the same as its English text (or has no zh-TW text at all) reads as an untranslated leftover.
// Names, units and placeholders are fine; anything with real English words must be translated or be listed here on purpose.
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhTW } from './zh-TW';

const ON_PURPOSE = new Set([
  'settings.group.discord', 'settings.row.live-room.label', 'settings.row.telegram.label', 'labs.telegram.name',
  'inboxCards.issue.header', 'inboxCards.issue.headerNumber', 'phone.setup.testNotifTitle', 'phone.menu.title',
  'r9.export.tabMarkdown', 'rail.out.kind.word', 'rail.out.kind.pdf', 'files.pdfLabel', 'devices.ssh.chip', 'devices.wslNamed', 'devices.ssh.targetPlaceholder',
]);
/** Two or more English words in a row once the {placeholders} are taken out. */
const wordy = (text: string) => /[A-Za-z]{2,}[ ,.]+[A-Za-z]{2,}/.test(text.replace(/\{[^}]+\}/g, ''));

describe('zh-TW leftovers', () => {
  it('no value is English text copied from its key (or missing), except on purpose', () => {
    const left = Object.entries(en)
      .filter(([key, text]) => wordy(String(text)) && ((zhTW as Record<string, string>)[key] ?? String(text)) === String(text) && !ON_PURPOSE.has(key))
      .map(([key]) => key);
    expect(left).toEqual([]);
  });

  it('says AI 助理 for an agent: no 代理程式 and no bare 代理 / 助理 left (小代理 and the proxy words are separate things)', () => {
    const bad = Object.entries(zhTW).filter(([, text]) => /代理程式|(?<!小)代理(?!人|伺服|商)|(?<!AI )(?<!AI)助理/.test(String(text)));
    // The always-on companion is "助理" on its own, on purpose.
    expect(bad.map(([key]) => key).filter((key) => !key.startsWith('companion.'))).toEqual([]);
  });
});
