// @vitest-environment node
// The 1.1.9 polish rules, read from the stylesheets: the thin sidebar has no sideways scrollbar, the pane's tab row has
// no orange underline, the About row has a gap, scrollbars are one global rule in theme tokens (light and dark), and the
// viewport units divide by the page zoom (html { zoom: var(--ui-scale) }), so cards near the window edge are not cut.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the rule whose selector is exactly `selector` (first match). */
const ruleBody = (css: string, selector: string): string => {
  const at = bare(css).indexOf(`${selector} {`);
  if (at < 0) return '';
  const open = bare(css).indexOf('{', at);
  return bare(css).slice(open + 1, bare(css).indexOf('}', open));
};

describe('thin sidebar (item 1)', () => {
  it('the sidebar list never scrolls sideways, and long words wrap inside their rows', () => {
    const css = read('cockpit-sidebar.css');
    expect(ruleBody(css, '.cockpit .ck-side-scroll')).toMatch(/overflow-x:\s*hidden/);
    expect(css).toMatch(/\.cockpit \.ck-side-scroll \.ck-row-main,[\s\S]*?overflow-wrap:\s*anywhere/);
  });
});

describe('pane tab row (item 4)', () => {
  it('the pressed tab keeps no orange line under it', () => {
    expect(ruleBody(read('cockpit-chat.css'), '.cockpit .ck-pane-head .ck-seg-pill::after')).toMatch(/display:\s*none/);
  });
});

describe('About row (item 25)', () => {
  it('the update and repair buttons have a gap, and the hint keeps a gap from its label', () => {
    const css = read('app-update.css');
    expect(ruleBody(css, '.app-update-row')).toMatch(/gap:\s*8px 12px/);
    expect(ruleBody(css, '.app-update-row .app-update-detail')).toMatch(/margin-left/);
    // The update notice inside the row sits on its own line under the button.
    expect(ruleBody(css, '.app-update-row .app-update-notice')).toMatch(/flex-basis:\s*100%/);
  });
});

describe('scrollbars (item 20)', () => {
  const scrollbars = read('scrollbars.css');
  it('one global rule sets the thin scrollbar with theme tokens, and no raw colour', () => {
    expect(scrollbars.trimStart().startsWith('/*')).toBe(true);
    expect(bare(scrollbars)).toMatch(/^\s*\*\s*\{/m);
    expect(bare(scrollbars)).toMatch(/scrollbar-width:\s*thin/);
    expect(bare(scrollbars)).toMatch(/scrollbar-color:\s*rgb\(var\(--pm-muted\) \/ 0\.4\) transparent/);
    expect(bare(scrollbars)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('the thumb uses the muted token, so it follows light and dark (both define --pm-muted on the root)', () => {
    expect(bare(scrollbars)).toMatch(/::-webkit-scrollbar-thumb \{[\s\S]*?rgb\(var\(--pm-muted\)/);
    const theme = read('theme.css');
    expect(theme).toMatch(/:root \{[\s\S]*?--pm-muted:/);
    expect(theme).toMatch(/:root\[data-theme='light'\] \{[\s\S]*?--pm-muted:/);
  });
  it('the global stylesheet imports it', () => {
    expect(read('index.css')).toMatch(/@import '\.\/scrollbars\.css';/);
  });
});

describe('viewport units under the page zoom (item 21)', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.css'));

  it('no full-window width or height is written as a bare 100vw or 100vh', () => {
    const bareUnits: string[] = [];
    for (const file of sheets) {
      const css = bare(read(file));
      // A bare unit is one not wrapped by the zoom division: the division always names --ui-scale.
      for (const m of css.matchAll(/\b100v[wh]\b/g)) {
        const line = css.slice(css.lastIndexOf('\n', m.index) + 1, css.indexOf('\n', m.index));
        if (!line.includes('--ui-scale')) bareUnits.push(`${file}: ${line.trim()}`);
      }
    }
    expect(bareUnits).toEqual([]);
  });

  it('the cards that were cut at the window edge divide by the zoom', () => {
    expect(ruleBody(read('app-update.css'), '.app-update-notice')).toMatch(/--ui-scale, 1\)\) - 32px/);
    expect(read('cockpit.css')).toMatch(/max-width: calc\(calc\(100vw \/ var\(--ui-scale, 1\)\) - 32px\)/);
  });

  it('the zoom variable is still the one html zooms by', () => {
    expect(read('comfort.css')).toMatch(/html \{\s*zoom: var\(--ui-scale, 1\);/);
  });
});
