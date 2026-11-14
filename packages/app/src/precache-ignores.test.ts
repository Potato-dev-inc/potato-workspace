import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the phone app precache', () => {
  it('leaves out every desktop-only file viewer chunk', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(config).toMatch(/globIgnores:\s*LAZY_VIEWER_IGNORES/);
    for (const name of ['DocxView', 'SheetView', 'PdfView', 'HtmlView']) {
      expect(config).toContain(`'**/${name}-*.js'`);
    }
  });
});
