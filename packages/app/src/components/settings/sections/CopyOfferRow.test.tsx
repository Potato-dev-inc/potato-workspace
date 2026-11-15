// @vitest-environment jsdom
// Settings > Agents > Where agents start > Offer "Work on a copy": a global switch (on by default) and, for the current
// project, a choice that wins over it. Both are kept on this device, in English and Traditional Chinese.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref, t } from '../../../i18n';
import { COPY_OFFER_KEY, copyOffered, getCopyOfferGlobal, getProjectOffer, setCopyOfferGlobal, setProjectOffer } from '../../../lib/copyOffer';
import { searchSections } from '../model';
import { click, makeEnv, mountRows, pickOption, type Mounted } from '../test-utils';
import { agentsRows } from './AgentsSection';

let m: Mounted;
const rows = agentsRows.filter((row) => row.id === 'copy-offer');

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  setCopyOfferGlobal(true);
});
afterEach(async () => {
  await m?.unmount();
  localStorage.clear();
});

describe('Offer "Work on a copy" (Settings > Agents)', () => {
  it('is one row in the "Where agents start" group, and search finds it by its words', () => {
    expect(rows.map((r) => [r.id, r.group])).toEqual([['copy-offer', 'Where agents start']]);
    expect(rows[0].level).toBeUndefined();
    const found = searchSections([{ id: 'agents', title: 'Agents', rows: agentsRows }] as never, 'trial copy').flatMap((s) => s.rows.map((r) => r.id));
    expect(found).toContain('copy-offer');
  });

  it('the global switch starts on, turns the offer off and on, and is kept', async () => {
    m = await mountRows(rows, { projectPath: null });
    const sw = m.host.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(m.host.querySelector('select')).toBeNull(); // no project: no per-project choice
    await click(sw);
    expect(getCopyOfferGlobal()).toBe(false);
    expect(localStorage.getItem(COPY_OFFER_KEY)).toBe('0');
    expect(copyOffered('/work/alpha')).toBe(false);
    await click(sw);
    expect(copyOffered('/work/alpha')).toBe(true);
  });

  it('the project choice wins over the global one, and "Same as above" gives it back', async () => {
    m = await mountRows(rows, { projectPath: '/Work/Alpha' });
    const select = m.host.querySelector<HTMLSelectElement>('select[aria-label="Work on a copy for this project"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Same as above', 'Always offer', 'Never offer']);
    expect(select.title).toBe('Alpha');
    await pickOption(select, 'off');
    expect(getProjectOffer('/work/alpha')).toBe('off');
    expect(copyOffered('/Work/Alpha')).toBe(false);
    setCopyOfferGlobal(false);
    await pickOption(select, 'on');
    expect(copyOffered('/Work/Alpha')).toBe(true);
    expect(copyOffered('/Work/Beta')).toBe(false);
    await pickOption(select, 'default');
    expect(getProjectOffer('/Work/Alpha')).toBe('default');
    expect(copyOffered('/Work/Alpha')).toBe(false);
  });

  it('says its words in Traditional Chinese too', () => {
    setProjectOffer('/x', 'on');
    setLanguagePref('zh-TW', false);
    expect(t('settings.row.copy-offer.label')).toContain('在副本上工作');
    expect(t('copyOffer.never')).toBe('一律不提供');
    setLanguagePref('en', false);
  });
});
