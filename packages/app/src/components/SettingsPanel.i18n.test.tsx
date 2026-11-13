// @vitest-environment jsdom
// The Settings shell and its Look and feel page in Traditional Chinese: nothing on screen is left in English, and
// search finds a row by its English words and by its Chinese label.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { t } from '../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../i18n/test-utils';
import { fakeOverviewSources } from './settings/overview-test-utils';
import { BASE_SETTINGS, click, settle, type as typeInto } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, autostartGet: vi.fn(async () => false), autostartSet: vi.fn(async () => undefined) } };
});

let host: HTMLDivElement;
let root: Root;

const api = (over: Partial<Settings> = {}): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS, ...over }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS, ...over }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});

async function mount(tab: 'overview' | 'look', over: Partial<Settings> = {}) {
  await act(async () => {
    root.render(<SettingsPanel open initialTab={tab} api={api(over)} overviewSources={fakeOverviewSources()} onClose={() => undefined} />);
  });
  await settle(10);
}

const search = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
const ALLOWED = ['Win', 'English']; // English: the language picker writes each language in itself

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

describe('Settings in Traditional Chinese', () => {
  it('Look and feel page: nav, title and every row are Chinese', async () => {
    await mount('look');
    expect(host.querySelector('h1')?.textContent).toBe(t('settings.page.look.title'));
    expect(host.textContent).toContain(t('settings.row.theme.label'));
    expect(host.textContent).toContain(t('settings.row.start-at-sign-in.label'));
    expect(host.textContent).toContain(t('settings.row.away-minutes.label'));
    expect(search().placeholder).toBe(t('settings.search'));
    expect(visibleEnglish(host, ALLOWED)).toEqual([]);
  });

  it('Overview page: cards and group headings are Chinese', async () => {
    await mount('overview');
    expect(host.querySelector('h1')?.textContent).toBe(t('settings.page.overview.title'));
    expect(host.querySelector('[data-card="agents"]')?.textContent).toContain(t('settings.card.agentsReady', { count: 2 }));
    expect(host.querySelector('[data-card="updates"]')?.textContent).toContain(t('settings.card.upToDate', { version: '1.0.19' }));
    const text = host.querySelector('.st-cards')!;
    // Sentences from the setup checks (lib/setup-checks) are still English; only the shell is checked here.
    expect(visibleEnglish(text, ['Claude', 'Codex'])).toEqual([]);
  });

  it('search finds a row by its English words and by its Chinese label, and shows the empty state', async () => {
    await mount('look');
    await typeInto(search(), 'theme');
    expect(host.querySelector('[data-row="theme"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(t('settings.title.search'));
    await typeInto(search(), t('settings.row.theme.label'));
    expect(host.querySelector('[data-row="theme"]')).not.toBeNull();
    await typeInto(search(), 'zzzzqq');
    expect(host.textContent).toContain(t('settings.empty.title', { query: 'zzzzqq' }));
    expect(visibleEnglish(host.querySelector('.st-main')!, ALLOWED.concat('zzzzqq'))).toEqual([]);
    await click(host.querySelector('.st-emptycard button')!);
    expect(host.querySelector('h1')?.textContent).toBe(t('settings.page.look.title'));
  });

  it('English still reads as before', async () => {
    useEnglish();
    await mount('look');
    expect(host.querySelector('h1')?.textContent).toBe('Look and feel');
    expect(host.textContent).toContain('Start Potato Workspace when I sign in');
    expect(search().placeholder).toBe('Search settings');
  });
});
