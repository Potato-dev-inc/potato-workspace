// Desktop Potato is an early (Labs) feature: off by default, and a development build turns it on like the others.
import { describe, expect, it } from 'vitest';
import { DEV_LABS_KEYS } from '../../lib/dev-labs';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { generalRows } from '../settings/sections/GeneralSection';

describe('the Desktop Potato Labs switch', () => {
  it('joins the development Labs keys once', () => {
    expect(DEV_LABS_KEYS.filter((k) => k === 'desktop_pet_enabled')).toHaveLength(1);
  });

  it('has a Labs row with a short name and one plain line', () => {
    const row = generalRows.find((r) => r.id === 'desktop-potato-labs')!;
    expect(row.group).toBe('Labs');
    expect(row.labs!.name).toBe('Desktop Potato');
    expect(row.labs!.about.split('.').filter(Boolean)).toHaveLength(1);
  });

  it('every pet message exists in both languages', () => {
    const keys = Object.keys(en).filter((k) => k.startsWith('pet.') || k.includes('desktop-potato-labs'));
    expect(keys.length).toBeGreaterThan(15);
    for (const key of keys) expect((zhTW as Record<string, string | undefined>)[key], key).toBeTruthy();
  });
});
