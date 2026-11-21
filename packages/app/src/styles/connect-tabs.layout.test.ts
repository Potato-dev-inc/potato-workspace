// The link-mode row layout bug: .cx-row-wide had an `auto` second column that took the whole one-line width of the buttons, so the
// heading column shrank to nothing and broke one character per line on wide windows (above 720 px). jsdom has no layout engine, so
// this checks the rules themselves: the fix is a single column at every width (not inside a media query), the route block is capped
// at 380 px, and the heading breaks only at word boundaries.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'connect-tabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as { selector, body, depth } (depth 0 = outside any @media). */
function rules(src: string) {
  const out: Array<{ selector: string; body: string; depth: number }> = [];
  let depth = 0;
  let buf = '';
  const stack: string[] = [];
  for (const ch of src) {
    if (ch === '{') {
      stack.push(buf.trim());
      buf = '';
      depth += 1;
    } else if (ch === '}') {
      const selector = stack.pop() ?? '';
      depth -= 1;
      if (!selector.startsWith('@')) out.push({ selector, body: buf, depth });
      buf = '';
    } else buf += ch;
  }
  return out;
}
const find = (selector: string) => rules(css).filter((r) => r.selector === selector);

describe('connect-tabs.css: link-mode row', () => {
  it('.cx-row-stack is one column at every width and never has an auto column', () => {
    const r = find('.cx-row.cx-row-stack');
    expect(r).toHaveLength(1);
    expect(r[0].depth).toBe(0);
    expect(r[0].body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
    expect(r[0].body).not.toMatch(/auto/);
    // its controls sit under the text, left-aligned, at every width
    const act = find('.cx-row.cx-row-stack .cx-act');
    expect(act).toHaveLength(1);
    expect(act[0].depth).toBe(0);
    expect(act[0].body).toMatch(/grid-column:\s*1\s*;/);
  });

  it('the 760, 900 and 1100 px windows get the same single column (no media query changes it)', () => {
    for (const width of [760, 900, 1100]) {
      const media = rules(css).filter((r) => r.depth > 0 && r.selector.includes('cx-row-stack'));
      expect(media, `${width}px`).toHaveLength(0);
    }
    // the only breakpoints in the file that touch rows narrow the wide row (the steps row), never grow a column back
    const queries = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(queries.every((w) => w <= 720)).toBe(true);
  });

  it('.cx-route is at most 380px wide and .cx-name breaks only at word boundaries', () => {
    const route = find('.cx-route');
    expect(route).toHaveLength(1);
    expect(route[0].body).toMatch(/max-width:\s*380px\s*;/);
    const name = find('.cx-name');
    expect(name).toHaveLength(1);
    expect(name[0].body).toMatch(/overflow-wrap:\s*break-word\s*;/);
    expect(name[0].body).not.toMatch(/anywhere|break-all/);
  });
});
