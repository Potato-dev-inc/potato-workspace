// @vitest-environment jsdom
// Team is a tab of the Connect page, which only the separate Settings window draws (in the cockpit Connect is in the sidebar).
// This uses the real catalog (the shell test next to it uses a tiny one).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamConfig } from '../dev/team-fixtures';
import { BASE_SETTINGS, click, settle, type as typeInto } from './settings/test-utils';
import { SECTIONS } from './settings/catalog';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';
import { settingsEntryTarget } from '../lib/settings-target';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

// Team talks to the Rust side through invoke(); answer the team commands, and nothing else.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'team_config_get') return teamConfig({ enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null });
    if (command === 'team_default_name') return 'Pat';
    // The Connect page shows the paired phones and the public address next to Team.
    if (command === 'list_paired_mobile_devices') return [];
    if (command === 'get_mobile_tunnel_info') return null;
    throw new Error(`not answered in this test: ${command}`);
  }),
}));
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
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const mount = async (props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => {
  await act(async () => root.render(<SettingsPanel open api={api} {...props} />));
  await settle(6);
};
const nav = () => [...host.querySelectorAll('.st-nav .st-nav-row')].map((b) => b.textContent);
const navButton = (title: string) => [...host.querySelectorAll('.st-nav .st-nav-row')].find((b) => b.textContent === title) as HTMLButtonElement;
const search = () => host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
const main = () => host.querySelector('.st-main') as HTMLElement;
const cardHeads = () => [...main().querySelectorAll('.st-closed-group')].map((c) => c.getAttribute('data-group'));
const card = (name: string) => main().querySelector(`.st-closed-group[data-group="${name}"]`) as HTMLElement;

describe('Settings window > Connect > Team', () => {
  const winMount = (props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => mount({ withConnect: true, ...props });

  it('the separate window has a Connect page in its nav, with an icon', async () => {
    await winMount();
    expect(nav()).toEqual(['Overview', 'Agents', 'Agents that agents start', 'Look and feel', 'Connect', 'Keys', 'Shortcuts', 'Labs', 'Advanced']);
    expect(navButton('Connect').querySelector('svg')).not.toBeNull();
  });

  it('opens from the nav on the Connect page, and the Team tab offers "Start a team"', async () => {
    await winMount();
    await click(navButton('Connect'));
    await settle(6);
    expect(main().querySelector('h1')!.textContent).toBe('Connect');
    expect(navButton('Connect').getAttribute('aria-current')).toBe('page');
    expect(main().textContent).not.toContain('Start a team');
    await click(main().querySelector('[data-testid="connect-tab-team"]') as HTMLElement);
    await settle(6);
    expect(main().textContent).toContain('Start a team');
  });

  it.each(['team', 'relay', 'invite', 'join'])('searching "%s" shows no Team row in Settings', async (word) => {
    await winMount({ initialTab: 'look' });
    await typeInto(search(), word);
    await settle(6);
    expect(main().querySelector('[data-row="team-page"]')).toBeNull();
    if (word === 'team') expect(main().querySelector('[data-testid="settings-open-connect"]')).not.toBeNull();
  });

  it('opens straight on the Team tab from a deep link (?tab=team and the old Team command)', async () => {
    await winMount({ initialTab: 'connect', initialConnectTab: 'team' });
    expect(main().querySelector('h1')!.textContent).toBe('Connect');
    expect(main().textContent).toContain('Start a team');
    expect(settingsEntryTarget('?settings=1&tab=team')).toEqual({ page: 'connect', connectTab: 'team' });
    expect(settingsEntryTarget('?settings=1&tab=phone')).toEqual({ page: 'connect', connectTab: 'devices' });
  });

  it('Look and feel shows no team rows: not in its rows, not in Labs, not on the page', async () => {
    const look = SECTIONS.find((s) => s.id === 'look')!;
    expect(look.rows.some((r) => r.id === 'team')).toBe(false);
    expect(look.rows.some((r) => /team/i.test(`${r.label} ${r.hint ?? ''}`) && !r.pointer)).toBe(false);
    expect(look.rows.some((r) => r.labs?.name === 'Team')).toBe(false);
    await mount({ initialTab: 'look' });
    expect(main().querySelector('h1')!.textContent).toBe('Look and feel');
    expect(main().querySelector('[data-row="team-page"]')).toBeNull();
    expect(main().querySelector('.st-team')).toBeNull();
    expect(main().textContent).not.toContain('Start a team');
  });
});
