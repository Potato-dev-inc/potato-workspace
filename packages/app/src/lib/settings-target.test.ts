// Deep links: every row, every section and every old tab name lands somewhere sensible.
import { describe, expect, it } from 'vitest';
import { SECTIONS } from '../components/settings/catalog';
import { LEGACY_TABS } from './settings-entry';
import { resolveSettingsTarget, settingsEntryTarget } from './settings-target';

describe('deep links to every row', () => {
  it('a row id opens the section that holds it, on that row', () => {
    for (const section of SECTIONS) {
      for (const row of section.rows) {
        expect(resolveSettingsTarget(row.id), `${section.id}/${row.id}`).toEqual({ page: section.id, row: row.id });
      }
    }
  });

  it('the same through `?tab=<row id>` and `?row=<row id>` of the Settings window URL', () => {
    for (const section of SECTIONS) {
      for (const row of section.rows) {
        expect(settingsEntryTarget(`?settings=1&tab=${row.id}`)).toEqual({ page: section.id, row: row.id });
        expect(settingsEntryTarget(`?settings=1&tab=${section.id}&row=${row.id}`)).toEqual({ page: section.id, row: row.id });
      }
    }
  });

  it('the names Rust can send are plain ids: letters, digits, "-" and "_" only (it drops anything else)', () => {
    for (const row of SECTIONS.flatMap((s) => s.rows)) expect(row.id, row.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('a page id opens the page without a row', () => {
    for (const section of SECTIONS) expect(resolveSettingsTarget(section.id)).toEqual({ page: section.id });
    expect(resolveSettingsTarget('later')).toEqual({ page: 'overview' });
  });

  it('"labs" opens Advanced > Early features (Labs); the features that moved are found by their old name too', () => {
    expect(resolveSettingsTarget('labs')).toEqual({ page: 'advanced', row: 'labs-index' });
    expect(resolveSettingsTarget('live-updates')).toEqual({ page: 'advanced', row: 'live-updates' });
    expect(resolveSettingsTarget('opencode-automation')).toEqual({ page: 'advanced', row: 'opencode-automation' });
    expect(resolveSettingsTarget('simple-mode')).toEqual({ page: 'advanced', row: 'simple-mode' });
    expect(resolveSettingsTarget('security-ask-before-control')).toEqual({ page: 'agents', row: 'security-ask-before-control' });
  });

  it('the old tab ids still land: pages where there was no row, rows where the page moved', () => {
    for (const old of Object.keys(LEGACY_TABS)) expect(resolveSettingsTarget(old), old).not.toBeNull();
    expect(resolveSettingsTarget('mobile')).toEqual({ page: 'connect' });
    expect(resolveSettingsTarget('preload')).toEqual({ page: 'agents', row: 'preload' });
    expect(resolveSettingsTarget('team')).toEqual({ page: 'connect' });
    expect(resolveSettingsTarget('general')).toEqual({ page: 'look' });
    expect(resolveSettingsTarget('security')).toEqual({ page: 'agents', row: 'security-ask-before-control' });
    expect(resolveSettingsTarget('plugins')).toEqual({ page: 'helpers', row: 'agent-pack' });
    expect(resolveSettingsTarget('costs')).toEqual({ page: 'agents', row: 'budget-turns' });
  });

  it('nothing or nonsense names nothing; the window falls back to Overview', () => {
    expect(resolveSettingsTarget('')).toBeNull();
    expect(resolveSettingsTarget(null)).toBeNull();
    expect(resolveSettingsTarget('nope')).toBeNull();
    expect(settingsEntryTarget('?settings=1')).toEqual({ page: 'overview' });
    expect(settingsEntryTarget('?settings=1&tab=nope&row=nope')).toEqual({ page: 'overview' });
  });
});
