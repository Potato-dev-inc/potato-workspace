// @vitest-environment jsdom
// Crews is an early (Labs) feature: off by default, a development build turns it on like the others, the switch is on the
// Early features page, and while it is on Settings > Helpers shows the Crews page (one line, the saved crews, and a way to open each on the canvas).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_LABS_KEYS, setDevLabsOverrideForTests, withDevLabs } from '../../lib/dev-labs';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SECTIONS, SECTIONS } from './catalog';
import { LABS_GROUP, LABS_INDEX_ID, collectLabs } from './arrange';
import { BASE_SETTINGS, click, mountRows, settle, type Mounted } from './test-utils';


let saved: Array<{ slug: string; name: string; roles: number; agents: string[]; problem: string | null }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'crews_list') return saved;
    throw new Error(`not answered in this test: ${command}`);
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let m: Mounted | undefined;
let host: HTMLDivElement;
let root: Root;
let settings: typeof BASE_SETTINGS;
const api: SettingsApi = {
  load: async () => ({ ...settings }),
  patch: async () => ({ ...settings }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(() => {
  saved = [];
  settings = { ...BASE_SETTINGS };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await m?.unmount();
  m = undefined;
  setDevLabsOverrideForTests(false);
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const row = () => collectLabs(BASE_SECTIONS).find((r) => r.id === 'crews-labs')!;
const main = () => host.querySelector('.st-main') as HTMLElement;
const mountPanel = async (props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => {
  await act(async () => root.render(<SettingsPanel open api={api} {...props} />));
  await settle(25);
};

describe('the Crews Labs switch', () => {
  it('joins the development Labs keys once', () => {
    expect(DEV_LABS_KEYS.filter((k) => k === 'crews_enabled')).toHaveLength(1);
  });

  it('is on the Early features page with a short name and one plain line', () => {
    const advanced = SECTIONS.find((s) => s.id === 'labs')!.rows;
    expect(advanced.some((r) => r.id === LABS_INDEX_ID && r.group === LABS_GROUP)).toBe(true);
    expect(advanced.some((r) => r.id === row().id)).toBe(false);
    expect(row().labs!.name).toBe('Crews');
    expect(row().labs!.about.split('. ')).toHaveLength(1);
    expect(row().labs!.about.length).toBeLessThanOrEqual(90);
  });

  it('shows off by default and saves crews_enabled when it is switched on', async () => {
    m = await mountRows([row()]);
    await settle(3);
    const toggle = m.host.querySelector<HTMLElement>('[role="switch"][aria-label="Crews"]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-checked')).toBe('false');
    await click(toggle);
    expect(m.env.patches).toEqual([{ crews_enabled: true }]);
  });

  it('in a development build the settings the row reads have it on, while the saved file keeps off', async () => {
    setDevLabsOverrideForTests(true);
    const stored = { ...BASE_SETTINGS, crews_enabled: false };
    const shown = withDevLabs(stored);
    expect(shown.crews_enabled).toBe(true);
    expect(stored.crews_enabled).toBe(false);
  });

  it('every message of the feature exists in both languages, and the Chinese is its own text', () => {
    const keys = Object.keys(en).filter((k) => k.includes('crews-labs') || k.startsWith('crews.') || k === 'settings.group.crews' || k.includes('crews-page'));
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const key of keys) {
      const zh = (zhTW as Record<string, string | undefined>)[key];
      expect(zh, key).toBeTruthy();
      expect(zh, key).not.toBe((en as Record<string, string>)[key]);
    }
  });
});

/** The page is lazy: wait until its content (not the empty Suspense) is drawn. */
const pageReady = async () => {
  for (let i = 0; i < 100 && !main().querySelector('[data-row="crews-page"] .crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(5);
};
describe('Settings > Helpers > Crews, through the real Settings screen', () => {
  it('with the switch off there is no Crews page', async () => {
    await mountPanel({ initialTab: 'helpers' });
    expect(main().querySelector('h1')!.textContent).toBe('Agents that agents start');
    expect(main().querySelector('[data-row="crews-page"]')).toBeNull();
    expect(main().textContent).not.toContain('A crew is a team of agents');
  });

  it('with the switch on the page is empty but for one line, and says there are no saved crews', async () => {
    settings = { ...BASE_SETTINGS, crews_enabled: true };
    await mountPanel({ initialTab: 'helpers', initialRow: 'crews-page' });
    await pageReady();
    const page = main().querySelector('[data-row="crews-page"]');
    expect(page).not.toBeNull();
    expect(page!.textContent).toContain('A crew is a team of agents, each with a job. Open one to see it as boxes, change it, and try a task on it.');
    expect(page!.textContent).toContain('No saved crews yet.');
    expect(page!.querySelectorAll('[data-testid="crew-row"]')).toHaveLength(0);
    // settings.css hides a group whose row has no .st-row or <section> child.
    expect(main().querySelector('[data-row="crews-page"] > section')).not.toBeNull();
  });

  it('lists the saved crews: name, roles, agents, why one cannot be used, and a button that opens it on the canvas', async () => {
    settings = { ...BASE_SETTINGS, crews_enabled: true };
    saved = [
      { slug: 'review', name: 'Review team', roles: 2, agents: ['claude', 'codex'], problem: null },
      { slug: 'old', name: 'Old crew', roles: 1, agents: ['gone'], problem: 'The agent "gone" for Lead is not set up here.' },
    ];
    await mountPanel({ initialTab: 'helpers', initialRow: 'crews-page' });
    await pageReady();
    const rows = [...main().querySelectorAll('[data-testid="crew-row"]')];
    expect(rows.map((r) => r.querySelector('.crews-row-name')!.textContent)).toEqual(['Review team', 'Old crew']);
    expect(rows[0].textContent).toContain('2 roles');
    expect(rows[0].textContent).toContain('claude, codex');
    expect(rows[1].textContent).toContain('1 role');
    expect(rows[1].textContent).toContain('Cannot be used yet: The agent "gone" for Lead is not set up here.');
    // The buttons open a crew on the canvas, or open a shared crew file (which saves nothing by itself).
    expect([...main().querySelectorAll('[data-row="crews-page"] button')].map((b) => b.textContent)).toEqual(['Open the canvas', 'Open the canvas', 'Open a shared crew…']);
  });
});
