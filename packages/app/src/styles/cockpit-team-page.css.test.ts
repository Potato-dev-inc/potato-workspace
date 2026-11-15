// @vitest-environment node
// The Team page is charcoal and grey: colours come from the cockpit tokens, every rule sits under the cockpit, and the
// orange accent is kept for the active tab, the under-10-minutes chip and the avatar hue that uses it.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./cockpit-team-page.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
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

describe('team page styles', () => {
  it('uses no colour literals', () => {
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i);
    expect(bare).not.toMatch(/:[^;{}]*\b(black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|lime|aqua|olive)\b/i);
  });

  it('only reads custom properties that exist', () => {
    const tokens = definedTokens();
    const used = [...bare.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(tokens.has(name), name).toBe(true);
  });

  it('uses --accent only on the active tab, the soon chip and one avatar hue', () => {
    const rules = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    const using = rules.filter(([, , body]) => /--accent(?!-)/.test(body)).map(([, selector]) => selector.trim().replace(/\s+/g, ' '));
    expect(using).toEqual([".cockpit .tpg-tab[aria-selected='true']", ".cockpit .tpg-avatar[data-hue='2']", ".cockpit .tpg-time[data-urgency='soon'], .cockpit .tpg-time[data-urgency='now']"]);
  });

  it('scopes every selector under the cockpit', () => {
    const selectors = [...bare.matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((s) => !s.startsWith('@'))
      .flatMap((s) => s.split(',').map((part) => part.trim()));
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).toMatch(/^\.cockpit (?:\.tpg|\.ck-empty\.tpg)/);
  });

  it('the page is the scroll area of the main column: it grows, may shrink to the window, scrolls, and its rows keep their height', () => {
    const rule = (selector: string) => [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.trim() === selector)?.[2] ?? '';
    const page = rule('.cockpit .tpg');
    expect(page).toMatch(/flex:\s*1 1 auto/);
    expect(page).toMatch(/min-height:\s*0/);
    expect(page).toMatch(/overflow-y:\s*auto/);
    expect(rule('.cockpit .tpg > *')).toMatch(/flex-shrink:\s*0/);
  });

  it('the lend sheet takes the mouse even when a layer around it ignores it, and its tag is a small inline tag', () => {
    const lend = readFileSync(new URL('./lend.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (selector: string) => [...lend.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.trim() === selector)?.[2] ?? '';
    expect(block('.lend-scrim')).toMatch(/pointer-events:\s*auto/);
    expect(block('.lend-tag')).toMatch(/align-self:\s*flex-start/);
    expect(block('.lend-tag')).toMatch(/width:\s*fit-content/);
  });
});
