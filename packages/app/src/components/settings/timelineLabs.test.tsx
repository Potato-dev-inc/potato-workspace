// @vitest-environment jsdom
// The Today page is an early (Labs) feature: off by default, a development build turns it on like the others,
// and the switch is on the Early features page where a person can find it.
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_LABS_KEYS, setDevLabsOverrideForTests, withDevLabs } from '../../lib/dev-labs';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { SECTIONS } from './catalog';
import { LABS_GROUP } from './arrange';
import { BASE_SETTINGS, click, mountRows, settle, type Mounted } from './test-utils';

let m: Mounted | undefined;
afterEach(async () => {
  await m?.unmount();
  m = undefined;
  setDevLabsOverrideForTests(false);
});

const row = () => SECTIONS.find((s) => s.id === 'advanced')!.rows.find((r) => r.id === 'timeline-labs')!;

describe('the Today page Labs switch', () => {
  it('joins the development Labs keys once', () => {
    expect(DEV_LABS_KEYS.filter((k) => k === 'timeline_day_enabled')).toHaveLength(1);
  });

  it('is on the Early features page with a short name and one plain line', () => {
    expect(row().group).toBe(LABS_GROUP);
    expect(row().labs!.name).toBe('Today page');
    expect(row().labs!.about.split('. ')).toHaveLength(1);
    expect(row().labs!.about.length).toBeLessThanOrEqual(90);
  });

  it('shows off by default and saves timeline_day_enabled when it is switched on', async () => {
    m = await mountRows([row()]);
    await settle(3);
    const toggle = m.host.querySelector<HTMLElement>('[role="switch"][aria-label="Today page"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-checked')).toBe('false');
    await click(toggle);
    expect(m.env.patches).toEqual([{ timeline_day_enabled: true }]);
  });

  it('in a development build the settings the row reads have it on, while the saved file keeps off', async () => {
    setDevLabsOverrideForTests(true);
    const saved = { ...BASE_SETTINGS, timeline_day_enabled: false };
    const shown = withDevLabs(saved);
    expect(shown.timeline_day_enabled).toBe(true);
    expect(saved.timeline_day_enabled).toBe(false);
    m = await mountRows([row()], { settings: shown });
    await settle(3);
    const toggle = m.host.querySelector<HTMLElement>('[role="switch"][aria-label="Today page"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('every message of the row exists in both languages, and the Chinese keeps the same shape', () => {
    const keys = Object.keys(en).filter((k) => k.includes('timeline-labs'));
    expect(keys.sort()).toEqual(['labs.timeline-labs.about', 'labs.timeline-labs.name', 'settings.row.timeline-labs.hint', 'settings.row.timeline-labs.label']);
    for (const key of keys) {
      const zh = (zhTW as Record<string, string | undefined>)[key];
      expect(zh, key).toBeTruthy();
      expect(zh, key).not.toBe((en as Record<string, string>)[key]);
    }
  });
});
