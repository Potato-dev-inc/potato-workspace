import { describe, expect, it } from 'vitest';
import { isSettingsEntry, resolveSettingsTab, settingsEntryTab } from './settings-entry';

describe('settings entry', () => {
  it('detects the settings route', () => {
    expect(isSettingsEntry('?settings=1&tab=agents')).toBe(true);
    expect(isSettingsEntry('?cockpit=1')).toBe(false);
  });

  it('defaults to Overview when the tab is missing or unknown', () => {
    expect(settingsEntryTab('?settings=1')).toBe('overview');
    expect(settingsEntryTab('?settings=1&tab=nope')).toBe('overview');
  });

  it('opens each of the eight pages by id', () => {
    for (const id of ['overview', 'agents', 'helpers', 'look', 'connect', 'keys', 'shortcuts', 'advanced']) {
      expect(settingsEntryTab(`?settings=1&tab=${id}`)).toBe(id);
    }
  });

  it('old section ids (general, models, bridge, phone, team, lend) still open a page', () => {
    const expected: Record<string, string> = { general: 'look', models: 'advanced', bridge: 'advanced', phone: 'connect', team: 'connect', lend: 'connect' };
    for (const [old, now] of Object.entries(expected)) expect(settingsEntryTab(`?settings=1&tab=${old}`)).toBe(now);
  });

  it('maps every old tab id to its new home, and the old Coming later words to Overview', () => {
    const expected: Record<string, string> = {
      appearance: 'look', storage: 'advanced', advanced: 'advanced', preload: 'agents', session: 'advanced',
      orchestrator: 'advanced', api: 'keys', mcp: 'advanced', developer: 'advanced', mobile: 'connect',
      security: 'agents', later: 'overview', notifications: 'overview', backup: 'overview', marketplace: 'overview',
      rules: 'overview', costs: 'overview', team: 'connect', automation: 'overview', observability: 'overview', plugins: 'advanced',
    };
    for (const [old, now] of Object.entries(expected)) expect(resolveSettingsTab(old)).toBe(now);
    expect(resolveSettingsTab('')).toBeNull();
    expect(resolveSettingsTab(null)).toBeNull();
  });
});
