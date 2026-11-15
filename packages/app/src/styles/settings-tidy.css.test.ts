// @vitest-environment node
// Settings tidy-up guards: the Overview card has no orange stripe, and every native <select> in Settings is themed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(here, f), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

describe('Settings top card', () => {
  it('has no orange stripe on its left edge', () => {
    const fixes = read('settings-fixes.css');
    const block = fixes.match(/\.settings \.st-card\[data-tone='fix'\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(block).not.toMatch(/border-left/);
    expect(fixes).not.toMatch(/\.st-card\[data-tone='fix'\]\s*\{[^}]*accent/);
  });
});

describe('native dropdowns follow the theme', () => {
  const theme = read('theme.css');
  const settings = read('settings.css');

  it('Settings and the cockpit tell the system which scheme they use, light and dark', () => {
    expect(theme).toMatch(/\.settings,\s*\.cockpit\s*\{\s*color-scheme:\s*dark/);
    expect(theme).toMatch(/\[data-theme='light'\] \.settings[\s\S]*?color-scheme:\s*light/);
  });

  it('the option list has its own background and text colour from the theme tokens', () => {
    const rule = theme.match(/select option,\s*select optgroup\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background-color:\s*rgb\(var\(--pm-panel\)\)/);
    expect(rule).toMatch(/color:\s*rgb\(var\(--pm-text\)\)/);
  });

  it('every select in the Settings window is styled by a themed rule', () => {
    expect(settings).toMatch(/\.settings \.st-popup,\s*\.settings \.st-field\s*\{[^}]*background-color/);
    expect(settings).toMatch(/\.settings select:not\(\.st-popup\)\s*\{[^}]*background-color:\s*var\(--fill\)[^}]*color:\s*var\(--label\)/);
  });

  it('no settings <select> sets its own light colours (white / black / light-scheme) inline or by class', () => {
    const settingsDir = path.join(here, '../components/settings');
    const bad: string[] = [];
    for (const file of sources(settingsDir)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<select\b[^>]*>/g)) {
        if (/style=\{\{[^}]*(background|color)/.test(m[0]) || /\b(bg|text)-(white|black|gray|zinc|neutral)/.test(m[0])) bad.push(`${path.basename(file)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
