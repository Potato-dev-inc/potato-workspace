// @vitest-environment jsdom
// Reachability: "Check my setup" is a row of the real catalog (Settings > Overview), Repair install opens it, and the row
// renders the page.
import { describe, expect, it, vi } from 'vitest';
import { SETUP_CHECK_ROW_ID, openSettingsAt } from '../../lib/openSettingsAt';
import { resolveSettingsTarget } from '../../lib/settings-target';
import { SECTIONS } from './catalog';
import { findRowSection } from './model';
import { hasText, mountRows, settle } from './test-utils';

describe('Check my setup is reachable in Settings', () => {
  it('the real catalog puts the row on Overview', () => {
    expect(findRowSection(SECTIONS, SETUP_CHECK_ROW_ID)?.id).toBe('overview');
  });

  it('a link to the row resolves to Settings > Overview on that row', () => {
    expect(resolveSettingsTarget('setup-check')).toEqual({ page: 'overview', row: 'setup-check' });
  });

  it('Repair install (openSettingsAt) opens the row', () => {
    const open = vi.fn();
    openSettingsAt('agents', SETUP_CHECK_ROW_ID, { open });
    expect(open).toHaveBeenCalledWith('setup-check');
  });

  it('the real row renders the page', async () => {
    const row = SECTIONS.find((s) => s.id === 'overview')!.rows.find((r) => r.id === SETUP_CHECK_ROW_ID)!;
    const m = await mountRows([row]);
    await settle(6);
    expect(hasText(m.host, 'Check again')).toBe(true);
    expect(m.host.querySelector('[data-testid="setup-check"]')).not.toBeNull();
    await m.unmount();
  });
});
