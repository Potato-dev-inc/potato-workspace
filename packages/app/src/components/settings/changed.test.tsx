// @vitest-environment jsdom
// The Changed dot, the Changed filter and Reset, through the real Settings panel (a small catalog stands in for the pages).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, click, settle } from './test-utils';
import { fakeOverviewSources } from './overview-test-utils';

vi.mock('./catalog', async () => ({ SECTIONS: (await import('./changed-test-utils')).testSections() }));
vi.mock('../../lib/settings-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/settings-recovery')>()),
  settingsRecoveryApi: { status: async () => ({ damaged: false, hasBackup: false }), restore: async () => undefined, dismiss: async () => undefined },
}));

import { SettingsPanel, type SettingsApi } from '../SettingsPanel';

let host: HTMLDivElement;
let root: Root;
let current: Settings;
let patch: ReturnType<typeof vi.fn>;

function makeApi(): SettingsApi {
  patch = vi.fn(async (change: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(change)) {
      if (v === null || v === undefined) delete (current as unknown as Record<string, unknown>)[k];
      else (current as unknown as Record<string, unknown>)[k] = v;
    }
    return { ...current };
  });
  return { load: vi.fn(async () => ({ ...current })), patch, findBridgeUrl: vi.fn(async () => null), subscribe: vi.fn(() => () => undefined) } as unknown as SettingsApi;
}

async function mount(initialTab: 'look' | 'overview' = 'look') {
  await act(async () => {
    root.render(<SettingsPanel open api={makeApi()} initialTab={initialTab} overviewSources={fakeOverviewSources()} />);
  });
  await settle(5);
}

const rowOf = (id: string) => host.querySelector(`[data-row="${id}"]`) as HTMLElement;
const chip = () => host.querySelector('.st-chip') as HTMLButtonElement | null;

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('the Changed dot', () => {
  it('a row whose keys differ from the default shows the Changed dot', async () => {
    current.theme = 'light';
    await mount();
    const dot = rowOf('theme').querySelector('.st-dot');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute('aria-label')).toBe('Changed from the default');
    expect(dot?.getAttribute('title')).toBe('Changed from the default');
    expect(rowOf('away').querySelector('.st-dot')).toBeNull(); // 5 is the default
    expect(rowOf('theme').querySelector('.st-reset')).not.toBeNull();
    // The nav shows the same dot after the name of a page that holds a changed row.
    const navRow = [...host.querySelectorAll('.st-nav-row')].find((b) => b.textContent?.includes('Look and feel'))!;
    expect(navRow.querySelector('.st-nav-dot')).not.toBeNull();
    expect([...host.querySelectorAll('.st-nav-row')].find((b) => b.textContent?.includes('Keys'))!.querySelector('.st-nav-dot')).toBeNull();
  });

  it('a value equal to the default is not changed', async () => {
    current.theme = 'dark';
    current.away_minutes = 5;
    await mount();
    expect(host.querySelectorAll('.st-dot')).toHaveLength(0);
    expect(chip()).toBeNull();
  });

  it('a row without keys never shows a dot or Reset', async () => {
    current.project_path = 'C:\\work';
    current.anthropic_api_key = 'sk-test';
    current.checkpoints_keep = 5;
    await mount();
    expect(rowOf('folder').querySelector('.st-dot')).toBeNull();
    expect(rowOf('folder').querySelector('.st-reset')).toBeNull();
    expect(rowOf('wipe').querySelector('.st-dot')).toBeNull(); // a danger row never shows one
    expect(rowOf('wipe').querySelector('.st-reset')).toBeNull();
    expect(host.querySelectorAll('.st-dot')).toHaveLength(0);
  });
});

describe('the Changed filter', () => {
  it('lists only changed rows with their paths, and says so when there are none', async () => {
    current.theme = 'light';
    current.display_name = 'Ren';
    await mount();
    expect(chip()?.textContent).toBe('Changed (2)');
    await click(chip());
    const main = host.querySelector('.st-main') as HTMLElement;
    expect(main.querySelector('h1')?.textContent).toBe('Changed');
    expect([...main.querySelectorAll('h2.st-path')].map((h) => h.textContent)).toEqual(['Look and feel › Appearance']);
    expect(rowOf('theme')).not.toBeNull();
    expect(rowOf('name')).not.toBeNull();
    expect(rowOf('away')).toBeNull();
    expect(rowOf('folder')).toBeNull();
    // Put both back with their own Reset buttons: the list says there is nothing left.
    await click(rowOf('theme').querySelector('.st-reset') as HTMLElement);
    await click(rowOf('name').querySelector('.st-reset') as HTMLElement);
    await settle(3);
    expect(main.textContent).toContain('Nothing changed. Everything is as it came.');
    await click([...main.querySelectorAll('button')].find((b) => b.textContent === 'Show all settings')!);
    expect(main.querySelector('h1')?.textContent).toBe('Look and feel');
  });

  it('Overview says "You changed N settings" and Show them turns the filter on', async () => {
    current.theme = 'light';
    await mount('overview');
    const line = host.querySelector('.st-quiet-line') as HTMLElement;
    expect(line.textContent).toContain('You changed 1 setting.');
    await click(line.querySelector('button'));
    expect((host.querySelector('.st-main h1') as HTMLElement).textContent).toBe('Changed');
    expect(rowOf('theme')).not.toBeNull();
  });

  it('an empty search offers "Show what I changed"', async () => {
    current.theme = 'light';
    await mount();
    const box = host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'zzzqqq');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const link = [...host.querySelectorAll('.st-quiet-links button')].find((b) => b.textContent === 'Show what I changed')!;
    expect(link).toBeDefined();
    await click(link);
    expect(rowOf('theme')).not.toBeNull();
    expect(box.value).toBe('');
  });
});

describe('Reset', () => {
  it("Reset patches only the row's own keys back to the default", async () => {
    current.theme = 'light';
    current.away_minutes = 9;
    current.display_name = 'Ren';
    await mount();
    await click(rowOf('theme').querySelector('.st-reset') as HTMLElement);
    await settle(3);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ theme: 'dark' });
    expect(current.away_minutes).toBe(9);
    expect(current.display_name).toBe('Ren');
    // A key with no default is removed, not set.
    await click(rowOf('name').querySelector('.st-reset') as HTMLElement);
    await settle(3);
    expect(patch).toHaveBeenLastCalledWith({ display_name: null });
    // The toast says what happened, in words.
    expect(host.querySelector('.st-toast')?.textContent).toContain('Reset. Your name: Empty');
  });
});
