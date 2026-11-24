// @vitest-environment node
// jsdom has no layout, so these read the CSS and pin the rules the live defects of run 21 depended on.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const flat = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const text = flat(css);
  const at = text.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return text.slice(text.indexOf('{', at) + 1, text.indexOf('}', at));
}

describe('far header: the chips collapse to one "where" chip by pane width, never vanish', () => {
  const css = read('pane-chrome.css');
  it('the pane is the container, and no window media query hides the chips', () => {
    expect(rule(css, '.cockpit .ck-pane')).toMatch(/container:\s*ckpane \/ inline-size/);
    expect(flat(css)).not.toMatch(/@media \(max-width: 1000px\) \{ \.cockpit \.ck-pane \.ck-pane-id \.ck-sub-inline/);
  });
  it('below 720px the chips hide and the compact chip shows; the compact chip is hidden above it', () => {
    const text = flat(css);
    const q = text.slice(text.indexOf('@container ckpane (max-width: 720px)'));
    expect(q).toMatch(/\.ck-pane-id \.ck-sub-inline \{ display: none/);
    expect(q).toMatch(/\.ck-pane-where \{ display: inline-flex/);
    expect(rule(css, '.cockpit .ck-pane .ck-pane-id .ck-pane-where')).toMatch(/display:\s*none/);
  });
  it('the device chip keeps at least 10 characters', () => {
    expect(rule(css, ".cockpit .ck-pane .ck-pane-id .ck-sub-inline[data-testid='pane-place']")).toMatch(/min-width:\s*10ch/);
  });
});

describe('Scores and Your plans: the table fills the page and gives up its minimum width when narrow', () => {
  for (const [file, scroll, table, box] of [
    ['cockpit-scores.css', '.cockpit .ck-scores-scroll', '.cockpit .ck-scores-table', 'ckscores'],
    ['cockpit-plans.css', '.cockpit .ck-plans-scroll', '.cockpit .ck-plans-table', 'ckplans'],
  ] as const) {
    it(`${file}: not squeezed by the controls, and cells wrap below 900px`, () => {
      const css = read(file);
      expect(rule(css, scroll)).toMatch(/flex:\s*1 0 auto/);
      expect(rule(css, scroll)).toMatch(/min-height:\s*0/);
      const text = flat(css);
      const q = text.slice(text.indexOf(`@container ${box} (max-width: 900px)`));
      expect(q).toMatch(/min-width: 0/);
      expect(q).toMatch(/white-space: normal/);
    });
  }
  it('the name column stays sticky', () => {
    expect(read('cockpit-scores.css')).toMatch(/tbody th,[\s\S]*position: sticky;\s*left: 0/);
  });
});

describe('New agent footer chips wrap instead of shrinking to stumps', () => {
  const css = read('cockpit-newagent.css');
  it('the row wraps and a chip never goes below its own width', () => {
    expect(rule(css, '.cockpit .ck-na-row')).toMatch(/flex-wrap:\s*wrap/);
    expect(flat(css)).toContain('.cockpit .ck-na-row > .ck-na-pop, .cockpit .ck-na-row > .mp { min-width: min(max-content, 100%); }');
  });
});

describe('Settings in a narrow window', () => {
  const css = read('settings.css');
  const narrow = flat(css).slice(flat(css).indexOf('@media (max-width: 599px)'));
  it('the cockpit grid loses the sidebar column (with :has() and with the data attribute fallback)', () => {
    expect(narrow).toMatch(/\.cockpit:has\(\.settings--inline\), \.cockpit\[data-settings-open\] \{ grid-template-columns: minmax\(0, 1fr\)/);
    expect(narrow).toMatch(/\.cockpit\[data-settings-open\] > \.ck-side, \.cockpit\[data-settings-open\] > \.ck-resize--side \{ display: none/);
  });
  it('the settings page itself is one column with the nav as a select', () => {
    expect(narrow).toMatch(/\.settings\.settings--inline \{ grid-template-columns: minmax\(0, 1fr\)/);
  });
  it('the narrow rules come after the wide inline rule, so they win at equal specificity', () => {
    expect(css.lastIndexOf('@media (max-width: 599px)')).toBeGreaterThan(css.indexOf('.settings.settings--inline {'));
  });
});

describe('Diagnostics review is a real dialog', () => {
  const css = read('settings.css');
  it('is fixed to the window, opaque, capped at 85vh (divided by the UI scale) with a scrolling body', () => {
    expect(rule(css, '.settings .st-scrim.st-diag-scrim')).toMatch(/position:\s*fixed/);
    const sheet = rule(css, '.settings .st-sheet.st-diag-sheet');
    expect(sheet).toMatch(/max-height:\s*calc\(calc\(85vh \/ var\(--ui-scale, 1\)\)\)/);
    expect(sheet).toMatch(/background:\s*var\(--window\)/);
    expect(sheet).toMatch(/backdrop-filter:\s*none/);
    expect(rule(css, '.settings .st-sheet.st-diag-sheet .st-diag-body')).toMatch(/overflow-y:\s*auto/);
    expect(rule(css, '.settings .st-sheet.st-diag-sheet .st-diag-actions')).toMatch(/flex:\s*none/);
  });
});

describe('Custom limits and ended far chat lines', () => {
  it('a unit never sits alone on a line', () => {
    const css = read('settings.css');
    expect(rule(css, '.settings .st-suffix')).toMatch(/white-space:\s*nowrap/);
    expect(rule(css, '.settings .st-limit-custom .st-number')).toMatch(/white-space:\s*nowrap/);
  });
  it('the "not here" line in the right panel wraps', () => {
    const css = read('cockpit-rail.css');
    expect(rule(css, '.cockpit .rp-row.is-empty .rp-name')).toMatch(/white-space:\s*normal/);
  });
});
