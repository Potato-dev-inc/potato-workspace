// @vitest-environment jsdom
// The Settings page with the REAL catalog: first view shows only basic rows, Advanced opens (and is remembered),
// developer rows wait for their switch, search finds hidden rows, and a Labs-flagged row follows its switch.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@puppet-master/shared';
import { BASE_SETTINGS, click, settle, type as typeInto } from './settings/test-utils';
import { SECTIONS } from './settings/catalog';
import { rowLevel } from './settings/model';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

let host: HTMLDivElement;
let root: Root;
let current: Settings;

function makeApi(): SettingsApi {
  return {
    load: vi.fn(async () => ({ ...current })),
    patch: vi.fn(async (patch: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(patch)) (current as unknown as Record<string, unknown>)[k] = v;
      return { ...current };
    }),
    findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
    subscribe: vi.fn(() => () => undefined),
  };
}

async function remount(props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount(props);
}

async function mount(props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) {
  await act(async () => {
    root.render(<SettingsPanel open api={makeApi()} {...props} />);
  });
  await settle(5);
}

const page = () => host.querySelector('.st-main') as HTMLElement;
const row = (id: string) => host.querySelector(`[data-row="${id}"]`);
const search = () => host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
const nav = (title: string) => [...host.querySelectorAll<HTMLButtonElement>('.st-nav-row')].find((b) => b.textContent?.includes(title));
const advancedToggle = () => host.querySelector<HTMLButtonElement>('.st-adv-toggle');
const sw = (label: string) => host.querySelector(`[role="switch"][aria-label="${label}"]`) as HTMLButtonElement | null;

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings levels on the real page', () => {
  it('first view of General shows only basic rows, and the Advanced group is closed', async () => {
    await mount();
    expect(row('your-name')).not.toBeNull();
    expect(row('theme')).not.toBeNull();
    expect(row('checkpoints')).toBeNull();
    expect(row('show-developer-settings')).toBeNull();
    expect(advancedToggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('Advanced opens on click, shows the advanced rows, and stays open after a remount', async () => {
    await mount();
    await click(advancedToggle());
    expect(row('checkpoints')).not.toBeNull();
    expect(advancedToggle()?.getAttribute('aria-expanded')).toBe('true');
    await remount();
    expect(row('checkpoints')).not.toBeNull();
  });

  it('a section with no basic rows opens its Advanced group by itself', async () => {
    await mount({ initialTab: 'bridge' });
    expect(row('toolbelt')).not.toBeNull();
    expect(advancedToggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('developer rows stay hidden until "Show developer settings" is on', async () => {
    await mount({ initialTab: 'bridge' });
    expect(row('bridge-endpoint')).toBeNull();
    await remount({ initialTab: 'general' });
    await click(advancedToggle());
    await click(sw('Show developer settings'));
    await settle(3);
    await remount({ initialTab: 'bridge' });
    expect(current.show_developer_settings).toBe(true);
    expect(row('bridge-endpoint')).not.toBeNull();
  });

  it('search finds a developer row while it is hidden, and shows it', async () => {
    await mount();
    await act(async () => {
      await typeInto(search(), 'bridge address');
    });
    await settle(3);
    expect(row('bridge-endpoint')).not.toBeNull();
    expect(page().textContent).toContain('Search results');
  });

  it('a row with a Labs switch follows that switch on the real page', async () => {
    await mount({ initialTab: 'agents' });
    await click(advancedToggle());
    expect(row('agent-lane')).toBeNull();
    current = { ...current, acp_chat_enabled: true };
    await remount({ initialTab: 'agents' });
    expect(row('agent-lane')).not.toBeNull(); // the Advanced group stays open: remembered
  });

  it('nav still reaches every section', async () => {
    await mount();
    for (const title of ['Agents', 'Keys', 'Phone']) expect(nav(title)).toBeDefined();
  });
});

describe('basic rows across the real catalog', () => {
  it('every row has a defined level', () => {
    for (const section of SECTIONS) for (const r of section.rows) expect(['basic', 'advanced', 'developer']).toContain(rowLevel(r));
  });

  it('shows at most 25 basic rows in all, and at most 25 in any one section', () => {
    const counts = SECTIONS.map((s) => s.rows.filter((r) => rowLevel(r) === 'basic').length);
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(25);
    for (const c of counts) expect(c).toBeLessThanOrEqual(25);
  });
});
