// @vitest-environment jsdom
// The project guide is an early (Labs) feature: off by default, a development build turns it on like the others,
// and the switch is on the Early features page where a person can find it.
import { afterEach, describe, expect, it } from 'vitest';
import { DEV_LABS_KEYS, setDevLabsOverrideForTests, withDevLabs } from '../../lib/dev-labs';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { BASE_SECTIONS, SECTIONS } from './catalog';
import { LABS_GROUP, LABS_INDEX_ID, collectLabs } from './arrange';
import { BASE_SETTINGS, click, mountRows, settle, type Mounted } from './test-utils';

let m: Mounted | undefined;
afterEach(async () => {
  await m?.unmount();
  m = undefined;
  setDevLabsOverrideForTests(false);
});

const row = () => collectLabs(BASE_SECTIONS).find((r) => r.id === 'project-guide-labs')!;

describe('the Project guide Labs switch', () => {
  it('joins the development Labs keys once', () => {
    expect(DEV_LABS_KEYS.filter((k) => k === 'project_guide_enabled')).toHaveLength(1);
  });

  it('is on the Early features page with a short name and one plain line', () => {
    // Early features are listed once, on the Labs page (the Labs row under Advanced), not as their own rows.
    const advanced = SECTIONS.find((s) => s.id === 'labs')!.rows;
    expect(advanced.some((r) => r.id === LABS_INDEX_ID && r.group === LABS_GROUP)).toBe(true);
    expect(advanced.some((r) => r.id === row().id)).toBe(false);
    expect(row().labs!.name).toBe('Project guide');
    expect(row().labs!.about.split('. ')).toHaveLength(1);
    expect(row().labs!.about.length).toBeLessThanOrEqual(90);
  });

  it('shows off by default and saves project_guide_enabled when it is switched on', async () => {
    m = await mountRows([row()]);
    await settle(3);
    const toggle = m.host.querySelector<HTMLElement>('[role="switch"][aria-label="Project guide"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-checked')).toBe('false');
    await click(toggle);
    expect(m.env.patches).toEqual([{ project_guide_enabled: true }]);
  });

  it('in a development build the settings the row reads have it on, while the saved file keeps off', async () => {
    setDevLabsOverrideForTests(true);
    const saved = { ...BASE_SETTINGS, project_guide_enabled: false };
    const shown = withDevLabs(saved);
    expect(shown.project_guide_enabled).toBe(true);
    expect(saved.project_guide_enabled).toBe(false);
    m = await mountRows([row()], { settings: shown });
    await settle(3);
    const toggle = m.host.querySelector<HTMLElement>('[role="switch"][aria-label="Project guide"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('every message of the row exists in both languages, and the Chinese keeps the same shape', () => {
    const keys = Object.keys(en).filter((k) => k.includes('project-guide-labs'));
    expect(keys.sort()).toEqual(['labs.project-guide-labs.about', 'labs.project-guide-labs.name', 'labsPage.line.project-guide-labs', 'settings.row.project-guide-labs.hint', 'settings.row.project-guide-labs.label']);
    for (const key of keys) {
      const zh = (zhTW as Record<string, string | undefined>)[key];
      expect(zh, key).toBeTruthy();
      expect(zh, key).not.toBe((en as Record<string, string>)[key]);
    }
  });
});
