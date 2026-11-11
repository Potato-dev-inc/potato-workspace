// @vitest-environment node
// Sidebar footer styles: in wide windows the Review label carries the count ("Review · 3"), so the round badge on
// the icon steps aside; in narrow windows only the icon shows, and the badge stays as the count.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./sidebar-footer.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('sidebar-footer.css', () => {
  it('hides the round Review badge only inside the wide-window block', () => {
    const wide = css.slice(css.indexOf('@media (min-width: 900px)'));
    expect(wide).toMatch(/\.ck-foot-review \.ck-foot-badge\s*\{\s*display: none;/);
    expect(css.slice(0, css.indexOf('@media'))).not.toContain('ck-foot-badge');
  });
});
