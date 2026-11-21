// @vitest-environment node
// The small sign-in terminal must show the whole agent screen: tall enough for it (never a fixed few lines), as wide as its
// column (no minimum that pokes out of it), inside a sheet that scrolls when the window is smaller. These are the rules that made it
// a 200 px / 320 px box (12 rows, about 33 columns) in the app; the numbers were measured in the running app.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const lend = read('lend.css');
const acp = read('cockpit-acp.css');
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
};

describe('the small sign-in terminal box', () => {
  it('is as tall as the window allows (a clamp from 280 px), never a fixed few lines', () => {
    const box = rule(lend, '.lend-term');
    expect(box).toMatch(/height:\s*clamp\(\s*280px,[^;]*vh[^;]*,\s*480px\s*\)/);
    expect(box).not.toMatch(/\bheight:\s*\d+px/);
    expect(box).toMatch(/min-width:\s*0\b/);
    expect(box).toMatch(/width:\s*100%/);
  });

  it('is not squeezed to 200 px or pushed to a 320 px minimum inside the chat card', () => {
    expect(acp).not.toMatch(/\.lend-term\s*\{[^}]*\b(?:min-width|height):\s*\d+px/);
  });

  it('gives the open terminal the whole width of its card by stacking the card', () => {
    expect(acp).toMatch(/\.ck-acp-card:has\(\.ck-acp-card-details\[open\]\)\s*\{[^}]*flex-direction:\s*column/);
  });

  it('has a 720 px sheet for the sign-in terminal (about 80 columns) that is the whole width on a small window', () => {
    expect(lend).toMatch(/\.lend-sheet\[data-size='term'\]\s*\{\s*width:\s*720px/);
    expect(lend).toMatch(/@media \(max-width: 760px\)\s*\{\s*\.lend-sheet\[data-size='term'\]\s*\{\s*width:\s*100%/);
    // The sheet scrolls instead of cutting the terminal off.
    expect(rule(lend, '.lend-sheet')).toMatch(/overflow-y:\s*auto/);
    expect(rule(lend, '.lend-sheet')).toMatch(/max-height:\s*calc\(/);
  });
});
