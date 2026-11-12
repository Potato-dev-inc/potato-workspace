// The screens the first roam could not reach must stay in the harness, or the screen scan (scripts/roam.mjs) skips them.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));
const names = new Set(readdirSync(DIR).map((f) => f.replace(/\.ts$/, '')));

const REQUIRED = [
  'cockpit-activity',
  'cockpit-history',
  'cockpit-receipt',
  'night-running',
  'night-tonight-empty',
  'night-morning-4-of-5',
  'team-page-none',
  'team-page-start',
  'team-page-relay',
  'team-page-offline',
  'first-run-project-git',
  'settings-whats-new',
  'settings-search',
];

describe('screen scan scenarios', () => {
  it('has a scenario for every screen the first roam could not open', () => {
    expect(REQUIRED.filter((n) => !names.has(n))).toEqual([]);
  });
});
