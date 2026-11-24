import { afterEach, describe, expect, it } from 'vitest';
import { useChinese, useEnglish } from '../i18n/test-utils';
import { localizeExportPreview } from './chatExportPreview';

const PAGE = '<html lang="en"><p class="eyebrow">Chat</p><h3>You</h3><div class="turn-end"><span>Worked for 1s</span></div><footer class="foot">Saved from Potato Workspace</footer>';
afterEach(() => useEnglish());
describe('localizeExportPreview', () => {
  it('leaves English alone', () => {
    useEnglish();
    expect(localizeExportPreview(PAGE, 'page')).toBe(PAGE);
  });
  it('says the fixed labels in zh-TW, only in the preview text', () => {
    useChinese();
    const out = localizeExportPreview(PAGE, 'page');
    expect(out).toContain('<p class="eyebrow">對話</p>');
    expect(out).toContain('<h3>你</h3>');
    expect(out).toContain('<span>工作了 1 秒</span>');
    expect(out).not.toContain('Saved from');
    expect(localizeExportPreview('**You**\n\n_Worked for 1s_\n\n_Saved from Potato Workspace_', 'markdown')).toBe('**你**\n\n_工作了 1 秒_\n\n_由 Potato Workspace 儲存_');
  });
  it('says the Done notice in zh-TW (page and Markdown)', () => {
    useChinese();
    expect(localizeExportPreview('<p class="notice">Done · 1 file · 24 s</p>', 'page')).not.toContain('Done');
    expect(localizeExportPreview('_Done · 1 file · 24 s_', 'markdown')).not.toContain('Done');
  });
});
