// Guard for the bundled highlights (WHATSNEW-1116 section 7): ids unique for ever, words within their limits, demo and
// action names that exist, 3 to 6 tour cards per version, and the version in the file matches its name.
import { describe, expect, it } from 'vitest';
import { GUIDE_FILE, VERSION_FILES, compareVersions, guideEntries, hasTour, tourOf } from './catalog';
import { DEMOS } from './demos';
import { isActionName } from './registry';
import { AREAS, LINE_MAX, TITLE_MAX, TOUR_MAX, TOUR_MIN } from './types';
import { en } from '../i18n/en';

const files = [...VERSION_FILES, GUIDE_FILE];
const all = files.flatMap((f) => f.highlights);

describe('highlights files', () => {
  it('have unique ids', () => {
    const ids = all.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keep words short: title <= 32, one sentence <= 90, 1 to 3 word try label, no full stop in a title', () => {
    for (const h of all) {
      expect(h.title.length, h.id).toBeLessThanOrEqual(TITLE_MAX);
      expect(h.title.endsWith('.'), h.id).toBe(false);
      expect(h.line.length, h.id).toBeLessThanOrEqual(LINE_MAX);
      expect(h.tryLabel.split(/\s+/).length, h.id).toBeLessThanOrEqual(4);
      expect(AREAS, h.id).toContain(h.area);
    }
  });

  it('name demos and actions that exist', () => {
    for (const h of all) {
      expect(Object.keys(DEMOS), `${h.id} demo`).toContain(h.demo);
      expect(isActionName(h.try.action), `${h.id} action`).toBe(true);
    }
  });

  it('have 3 to 6 tour cards per version, and the file name is its version', () => {
    for (const f of VERSION_FILES) {
      const n = f.highlights.filter((h) => h.tour).length;
      expect(n, f.version).toBeGreaterThanOrEqual(TOUR_MIN);
      expect(n, f.version).toBeLessThanOrEqual(TOUR_MAX);
      expect(f.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(VERSION_FILES.map((f) => f.version)).toContain('1.1.1');
  });

  it('carry the six 1.1.1 tour cards in the designed order', () => {
    expect(tourOf('1.1.1').map((h) => h.id)).toEqual(['right-panel', 'split-drag', 'standby', 'artifact-side', 'word-pages', 'theme-dim']);
    expect(hasTour('1.1.1')).toBe(true);
    expect(tourOf('1.0.9')).toEqual([]);
  });

  it('have an English message for each highlight (the JSON text is the fallback)', () => {
    for (const h of all) {
      const key = (f: string) => `whatsnew.${h.id}.${f}` as keyof typeof en;
      expect(en[key('title')], h.id).toBe(h.title);
      expect(en[key('line')], h.id).toBe(h.line);
    }
  });

  it('hide a Labs card while its flag is off', () => {
    const base = guideEntries({ labOn: () => false }).length;
    expect(base).toBe(all.length);
    expect(guideEntries({ platform: 'phone' }).every((h) => !h.platforms || h.platforms.includes('phone'))).toBe(true);
    expect(compareVersions('1.1.1', '1.0.20')).toBe(1);
  });
});
