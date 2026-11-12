// @vitest-environment node
// Settings > Lend lines up with Settings > Team: the same wrapper padding and gap, so the two pages start at the same
// edge. A team member's lend line wraps under the name instead of pushing the buttons out of their row.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one rule (the first one whose selector is exactly `selector`). */
function rule(css: string, selector: string): Record<string, string> {
  const m = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.trim() === selector);
  if (!m) throw new Error(`no rule ${selector}`);
  return Object.fromEntries(
    m[2]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );
}

describe('Lend page wrapper matches the Team page', () => {
  it('uses the same padding and gap as .st-team.tp', () => {
    const lend = rule(read('lend.css'), '.lend-page');
    const team = rule(read('settings.css'), '.tp');
    expect(lend.padding).toBe(team.padding);
    expect(lend.gap).toBe(team.gap);
  });
});

describe('team member rows', () => {
  it('wrap, and the name column can shrink so lend lines go under the name', () => {
    const css = read('settings.css');
    expect(rule(css, '.st-team-member')['flex-wrap']).toBe('wrap');
    expect(rule(css, '.st-team-who')['flex']).toBe('1 1 180px');
  });
});
