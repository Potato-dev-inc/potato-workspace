import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('settings saves are honest', () => {
  it('the panel rethrows a failed save so callers do not run their saved path', () => {
    const src = read('../SettingsPanel.tsx');
    const from = src.indexOf('} catch (error) {', src.indexOf('const save'));
    expect(src.slice(from, from + 500)).toMatch(/throw error/);
  });

  it('no block swallows a settingsSet error with an empty catch', () => {
    for (const file of ['blocks/AskBarSettings.tsx', 'blocks/LoopGuardSettings.tsx']) {
      const src = read(file);
      expect(src, file).not.toMatch(/settingsSet\([^)]*\)[\s\S]{0,200}\.catch\(\(\) => (\{\}|undefined)\)/);
    }
  });

  it('markSaved only follows an awaited patch inside a try block', () => {
    for (const file of ['sections/GeneralSection.tsx', 'sections/KeysSection.tsx']) {
      const src = read(file);
      for (const m of src.matchAll(/await env\.patch\([^;]*\);\s*env\.markSaved\(\);/g)) {
        const before = src.slice(Math.max(0, (m.index ?? 0) - 600), m.index);
        expect(before, file).toMatch(/try \{/);
      }
    }
  });
});
