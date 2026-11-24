// @vitest-environment jsdom
// Settings in the cockpit has no Connect page: the phone, the team and lending live on the Connect page in the sidebar.
// Rendered through the real panel and the real catalog.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectTabFor, registerConnectOpener } from '../lib/openConnect';
import { BASE_SETTINGS, click, settle, type as typeInto } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS }),
  patch: async () => ({ ...BASE_SETTINGS }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  registerConnectOpener(null);
  await act(async () => root.unmount());
  host.remove();
});

const mount = async (props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => {
  await act(async () => root.render(<SettingsPanel open inline api={api} {...props} />));
  await settle(6);
};
const nav = () => [...host.querySelectorAll('.st-nav .st-nav-row')].map((b) => b.textContent);
const main = () => host.querySelector('.st-main') as HTMLElement;
const search = () => host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;

describe('Settings in the cockpit has no Connect page', () => {
  it('the nav has no Connect, and no closed cards for Phone, Team, Lend or Discord', async () => {
    await mount();
    expect(nav()).toEqual(['Overview', 'Agents', 'Agents that agents start', 'Look and feel', 'Keys', 'Shortcuts', 'Labs', 'Advanced']);
    expect(host.querySelector('.st-closed-group[data-group="Phone"]')).toBeNull();
    expect(host.querySelector('[data-testid^="connect-link-"]')).toBeNull();
  });

  it.each(['pair', 'phone', 'team', 'lend'])('searching "%s" ends in one "Open Connect" result, and it opens the Connect page', async (word) => {
    const opened: string[] = [];
    registerConnectOpener((tab) => opened.push(tab));
    await mount({ initialTab: 'look' });
    await typeInto(search(), word);
    await settle(6);
    expect(main().querySelectorAll('[data-testid="settings-open-connect"]')).toHaveLength(1);
    await click(main().querySelector('[data-testid="settings-open-connect"] button'));
    expect(opened).toEqual(['devices']);
  });

  it('"borrow" + Down + Enter opens the highlighted result (the Connect one is first, Down reaches the next)', async () => {
    const opened: string[] = [];
    registerConnectOpener((tab) => opened.push(tab));
    await mount({ initialTab: 'look' });
    await typeInto(search(), 'borrow');
    await settle(6);
    const key = async (k: string) => act(async () => void search().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
    // First highlighted result is the Open Connect button: Enter opens Connect and not a Labs row.
    expect(main().querySelector('[data-testid="settings-open-connect"] [data-active="true"]')).not.toBeNull();
    await key('Enter');
    expect(opened).toEqual(['devices']);
  });

  it('Overview shows four cards, none of them a Phone card', async () => {
    await mount();
    expect(host.querySelectorAll('.st-card')).toHaveLength(4);
    expect(host.querySelector('[data-card="phone"]')).toBeNull();
    expect(main().textContent).not.toContain('Pair a phone');
  });

  it('Discord alerts is on Look and feel, with the other alerts', async () => {
    await mount({ initialTab: 'look' });
    await click(host.querySelector('.st-adv-toggle'));
    expect(main().querySelector('[data-row="discord-alerts"]')).not.toBeNull();
    expect(main().querySelector('[data-row="live-room"]')).toBeNull();
  });

  it('the old names still stand for a Connect tab', () => {
    expect(connectTabFor('phone')).toBe('devices');
    expect(connectTabFor('connect')).toBe('devices');
    expect(connectTabFor('devices')).toBe('devices');
    expect(connectTabFor('team')).toBe('team');
    expect(connectTabFor('lend')).toBe('lending');
  });
});
