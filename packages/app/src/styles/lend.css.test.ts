// @vitest-environment node
// The Ask to borrow sheet is interactive at once: a short fade (150 ms at most) and never pointer-events: none on the scrim.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./lend.css', import.meta.url), 'utf8');
const rule = (selector: string): string => css.slice(css.indexOf('{', css.indexOf(`${selector} {`)) + 1, css.indexOf('}', css.indexOf(`${selector} {`)));

describe('the lend sheet opens interactive', () => {
  it('takes the mouse at once and animates for 150 ms at most', () => {
    const scrim = rule('.lend-scrim');
    expect(scrim).toMatch(/pointer-events:\s*auto/);
    const ms = Number(/animation:\s*[\w-]+\s+(\d+)ms/.exec(scrim)?.[1] ?? '0');
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(150);
  });
});
