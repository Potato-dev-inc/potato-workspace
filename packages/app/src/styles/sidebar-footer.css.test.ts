// @vitest-environment node
// Sidebar footer styles: Review lives in the "..." menu now, so no round badge rule is left in the footer. The wide-window
// block (900px) only adds the labels beside the icons.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./sidebar-footer.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('sidebar-footer.css', () => {
  it('has no Review badge rule (Review moved into the ... menu)', () => {
    expect(css).not.toContain('ck-foot-badge');
    expect(css).not.toContain('ck-foot-review');
  });

  it('shows the labels beside the icons only inside the wide-window block', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 900px)'));
    expect(wide).toMatch(/\.ck-foot-label\s*\{\s*display: inline;/);
    expect(css.slice(0, css.indexOf('@media'))).not.toMatch(/\.ck-foot-label\s*\{\s*display: inline;/);
  });
});
