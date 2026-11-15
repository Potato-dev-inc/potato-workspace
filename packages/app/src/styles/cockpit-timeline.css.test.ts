// @vitest-environment node
// The Today page's styles use the cockpit tokens only (so light, dimmed and dark all follow), keep every rule under
// the cockpit, keep the keyframe-free motion short (120 ms) and turn it off for reduced motion. Orange is only the
// time handle and the picked mark.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./cockpit-timeline.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

function definedTokens(): Set<string> {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.css')) continue;
    for (const match of readFileSync(`${dir}${file}`, 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) names.add(match[1]);
  }
  return names;
}

describe('today page styles', () => {
  it('uses no colour literals', () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
    expect(bare).not.toMatch(/:[^;{}]*\b(black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|lime|aqua|olive)\b/i);
  });

  it('only reads custom properties that exist', () => {
    const tokens = definedTokens();
    const used = [...bare.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(tokens.has(name), name).toBe(true);
  });

  it('scopes every selector under the cockpit', () => {
    const selectors = [...bare.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith('@') && !/^(to|from|\d+%)$/.test(s))
      .flatMap((s) => s.split(',').map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).toMatch(/^\.cockpit \.ck-tl/);
  });

  it('uses the accent only for the handle and the picked mark', () => {
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /var\(--accent/.test(m[2]));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector] of rules) expect(selector, selector).toMatch(/handle|aria-pressed='true'/);
  });

  it('moves the handle and the card in 120 ms, and not at all for reduced motion', () => {
    expect(bare).toMatch(/\.ck-tl-handle \{[^}]*transition: left 120ms/);
    expect(bare).toMatch(/\.ck-tl-card \{[^}]*transition: opacity 120ms/);
    const reduce = bare.slice(bare.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toMatch(/\.ck-tl-handle[\s\S]*transition: none/);
  });

  it('sizes a lane at 28 px and a mark at 8 px inside a 24 px hit area', () => {
    expect(bare).toMatch(/\.ck-tl-lane \{[^}]*height: 28px/);
    expect(bare).toMatch(/\.ck-tl-dot \{[^}]*width: 8px[^}]*height: 8px/);
    expect(bare).toMatch(/\.ck-tl-mark \{[^}]*width: 24px[^}]*height: 24px/);
  });
});
