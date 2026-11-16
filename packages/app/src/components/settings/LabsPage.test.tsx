// @vitest-environment jsdom
// The Labs page (Advanced > Early features) through the real layout: areas render, search filters, and a switch
// still saves through the same patch its own row uses.
import { afterEach, describe, expect, it } from 'vitest';
import { arrangeSections, LABS_INDEX_ID } from './arrange';
import { BASE_SECTIONS } from './catalog';
import { click, hasText, mountRows, settle, type Mounted, type as typeInto } from './test-utils';
import { setDevLabsOverrideForTests } from '../../lib/dev-labs';

let m: Mounted | undefined;
afterEach(async () => {
  await m?.unmount();
  m = undefined;
  setDevLabsOverrideForTests(false);
});

const labsIndex = () => arrangeSections(BASE_SECTIONS).find((s) => s.id === 'labs')!.rows.find((r) => r.id === LABS_INDEX_ID)!;
const areaTitles = () => [...(m?.host.querySelectorAll('.st-labs-area h4') ?? [])].map((h) => h.textContent);
const nightSwitch = () => m?.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Night Shift"]');
const search = () => m!.host.querySelector<HTMLInputElement>('input[type="search"]')!;

describe('the Labs page', () => {
  it('groups the early features by area, in order, each with its one line', async () => {
    setDevLabsOverrideForTests(false);
    m = await mountRows([labsIndex()]);
    await settle(3);
    expect(areaTitles()).toEqual(['Chat', 'Agents that agents start', 'Devices', 'Team', 'Phone', 'Other']);
    expect(hasText(m.host, 'Agents work overnight in copies. You keep or drop each one in the morning.')).toBe(true);
    expect(hasText(m.host, 'Missions')).toBe(true);
  });

  it('search narrows the list and says so when nothing matches, then clearing it brings the groups back', async () => {
    setDevLabsOverrideForTests(false);
    m = await mountRows([labsIndex()]);
    await settle(3);
    await typeInto(search(), 'overnight');
    await settle(2);
    expect(areaTitles()).toEqual(['Agents that agents start']);
    expect(nightSwitch()).not.toBeNull();
    expect(hasText(m.host, 'Missions')).toBe(false);
    await typeInto(search(), 'zzz-no-match');
    await settle(2);
    expect(areaTitles()).toEqual([]);
    expect(hasText(m.host, 'No early feature matches "zzz-no-match".')).toBe(true);
    await typeInto(search(), '');
    await settle(2);
    expect(areaTitles()).toEqual(['Chat', 'Agents that agents start', 'Devices', 'Team', 'Phone', 'Other']);
  });

  it('the Lend switch lives on the Labs page, found by searching "lend", and saves lend_enabled', async () => {
    setDevLabsOverrideForTests(false);
    m = await mountRows([labsIndex()]);
    await settle(3);
    await typeInto(search(), 'lend');
    await settle(2);
    const lendSwitch = m.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Lend an agent"]');
    expect(lendSwitch).not.toBeNull();
    expect(lendSwitch!.getAttribute('aria-checked')).toBe('false');
    await click(lendSwitch);
    await settle(2);
    expect(m.env.patch).toHaveBeenCalledWith({ lend_enabled: true });
  });

  it('a switch still saves through the same patch as its own row', async () => {
    setDevLabsOverrideForTests(false);
    m = await mountRows([labsIndex()]);
    await settle(3);
    expect(nightSwitch()!.getAttribute('aria-checked')).toBe('false');
    await click(nightSwitch());
    await settle(2);
    expect(m.env.patch).toHaveBeenCalledWith({ night_shift_enabled: true });
    expect(m.env.patches).toEqual([{ night_shift_enabled: true }]);
  });
});
