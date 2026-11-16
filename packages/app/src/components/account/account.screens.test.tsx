// @vitest-environment jsdom
// Potato account as a whole screen: Connect > My PCs, through the real ConnectPage. Only the command layer is a fake
// (AccountApi). Proves: nothing shows while the Labs switch is off; the one "Sign in to Potato" button starts the
// browser sign-in and the page waits for the link; a finished sign-in shows "My devices"; Sign out this device and
// Sign out on another device ask the right command; a device that signed in in the last 24 hours gets the
// "New device · Not me?" banner (and an old one, this one, or a dismissed one does not); "Not me?" signs it out and
// gives the advice; the service not being set up disables the button.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { AccountApi, AccountDevice, AccountView } from '../../lib/account';
import { registerConnectOpener, type ConnectTab } from '../../lib/openConnect';
import type { TeamApi } from '../../lib/team';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';
import { resetRememberedTab } from '../team-page/TeamPage';
import { ConnectPage, type ConnectApi } from '../connect/ConnectPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  registerConnectOpener(null);
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const ME = '11111111-1111-4111-8111-111111111111';
const LAPTOP = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';

const dev = (over: Partial<AccountDevice>): AccountDevice => ({ id: ME, kind: 'pc', name: 'Desk', created_at: NOW - 100 * HOUR, last_seen_at: NOW, online: true, revoked: false, not_me: false, is_this: false, ...over });

const SIGNED_OUT: AccountView = { configured: true, signed_in: false, waiting: false, message: null, account: null, device_id: null };
const SIGNED_IN: AccountView = { configured: true, signed_in: true, waiting: false, message: null, account: { id: 'a1', display_name: 'Test Person', provider: 'password' }, device_id: ME };

interface FakeAccount extends AccountApi {
  calls: string[];
  view: AccountView;
  list: AccountDevice[];
  fire: () => void;
}

function fakeAccount(view: AccountView, list: AccountDevice[] = []): FakeAccount {
  const listeners = new Set<() => void>();
  const f: FakeAccount = {
    calls: [],
    view,
    list,
    fire: () => listeners.forEach((l) => l()),
    state: async () => f.view,
    signIn: async () => {
      f.calls.push('signIn');
      f.view = { ...f.view, waiting: true };
      return f.view;
    },
    cancel: async () => {
      f.calls.push('cancel');
      f.view = { ...f.view, waiting: false };
      return f.view;
    },
    devices: async () => ({ signed_in: f.view.signed_in, devices: f.list }),
    revoke: async (id, action) => {
      f.calls.push(`${action}:${id}`);
      return { signed_in: true, devices: f.list.map((d) => (d.id === id ? { ...d, revoked: true } : d)) };
    },
    signOutHere: async () => {
      f.calls.push('signOutHere');
      f.view = SIGNED_OUT;
      return f.view;
    },
    onChanged: async (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return f;
}

function fakeTeam(): TeamApi {
  return {
    state: async () => teamState({ active: false, presence: [] }),
    configGet: async () => teamConfig({ team: '' }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
}

function connectApi(account: AccountApi, settings: Partial<Settings> = { account_enabled: true }): Partial<ConnectApi> {
  const state = { ...BASE_SETTINGS, devices_enabled: true, lend_enabled: true, ...settings } as Settings;
  return {
    loadSettings: async () => state,
    patchSettings: async () => state,
    listPhones: async () => [],
    devices: new DevicesFake({ enabled: true }),
    team: fakeTeam(),
    lend: createFakeLendApi(lendState({ grants: [] })),
    account,
  };
}

function Screen({ api }: { api: Partial<ConnectApi> }) {
  const [tab, setTab] = useState<ConnectTab>('pcs');
  return <ConnectPage tab={tab} onTab={setTab} api={api} />;
}

async function mount(api: Partial<ConnectApi>) {
  await act(async () => root.render(<Screen api={api} />));
  await settle(10);
}

describe('Potato account on the Connect page', () => {
  it('draws nothing while the Labs switch is off', async () => {
    await mount(connectApi(fakeAccount(SIGNED_OUT), { account_enabled: false }));
    expect(q('[data-testid="account-panel"]')).toBeNull();
    expect(q('[data-testid="devices-page"]')).not.toBeNull();
  });

  it('signed out: one Sign in to Potato button starts the browser sign-in and the page waits for it', async () => {
    const account = fakeAccount(SIGNED_OUT);
    await mount(connectApi(account));
    const button = q<HTMLButtonElement>('[data-testid="account-sign-in"]')!;
    expect(button.textContent).toBe('Sign in to Potato');
    expect(button.disabled).toBe(false);
    expect(document.querySelectorAll('[data-testid="account-sign-in"]')).toHaveLength(1);
    await click(button);
    await settle(6);
    expect(account.calls).toEqual(['signIn']);
    expect(text('[data-testid="account-waiting"]')).toBe('Finish signing in in your browser.');
    expect(q('[data-testid="account-sign-in"]')).toBeNull();
    await click(q('[data-testid="account-cancel"]'));
    await settle(6);
    expect(account.calls).toEqual(['signIn', 'cancel']);
    expect(q('[data-testid="account-sign-in"]')).not.toBeNull();
  });

  it('a sign-in that finishes in the browser shows the signed-in name and the devices', async () => {
    const account = fakeAccount({ ...SIGNED_OUT, waiting: true }, []);
    await mount(connectApi(account));
    expect(q('[data-testid="account-waiting"]')).not.toBeNull();
    account.view = SIGNED_IN;
    account.list = [dev({ id: ME, name: 'Desk', is_this: true })];
    await act(async () => account.fire());
    await settle(8);
    expect(text('[data-testid="account-as"]')).toBe('Signed in as Test Person.');
    expect(text(`[data-testid="account-device-${ME}"]`)).toContain('Desk');
    expect(text(`[data-testid="account-device-${ME}"]`)).toContain('This device');
  });

  it('the account service not being set up disables the button and says so', async () => {
    await mount(connectApi(fakeAccount({ ...SIGNED_OUT, configured: false })));
    expect(q<HTMLButtonElement>('[data-testid="account-sign-in"]')!.disabled).toBe(true);
    expect(text('[data-testid="account-not-ready"]')).toBe('The account service is not set up yet.');
  });

  it('shows the error sentence the backend gave', async () => {
    await mount(connectApi(fakeAccount({ ...SIGNED_OUT, message: 'Could not reach the account service. Check your connection and try again.' })));
    expect(text('[data-testid="account-error"]')).toContain('Could not reach the account service');
  });

  describe('signed in', () => {
    const list = () => [
      dev({ id: ME, name: 'Desk', is_this: true }),
      dev({ id: LAPTOP, name: 'Laptop', created_at: NOW - 3 * HOUR, last_seen_at: NOW - 600, online: false }),
      dev({ id: OLD, name: 'Old tablet', kind: 'phone', created_at: NOW - 200 * HOUR, last_seen_at: NOW - 30 * HOUR, online: false }),
    ];

    it('lists the devices, says how long ago each was seen, and never shows a token', async () => {
      await mount(connectApi(fakeAccount(SIGNED_IN, list())));
      expect(document.querySelectorAll('[data-testid^="account-device-"]')).toHaveLength(3);
      expect(text(`[data-testid="account-device-${LAPTOP}"]`)).toContain('Seen');
      expect(text(`[data-testid="account-device-${OLD}"]`)).toContain('Phone');
      expect(text(`[data-testid="account-device-${ME}"]`)).toContain('Online now');
      expect(text('[data-testid="account-panel"]')).toContain('does not let it reach this PC');
    });

    it('Sign out this device signs out here; Sign out on another device asks to sign that one out', async () => {
      const account = fakeAccount(SIGNED_IN, list());
      await mount(connectApi(account));
      expect(text(`[data-testid="account-sign-out-${ME}"]`)).toBe('Sign out this device');
      expect(text(`[data-testid="account-sign-out-${OLD}"]`)).toBe('Sign out');
      await click(q(`[data-testid="account-sign-out-${OLD}"]`));
      await settle(8);
      expect(account.calls).toEqual([`sign_out:${OLD}`]);
      await click(q(`[data-testid="account-sign-out-${ME}"]`));
      await settle(8);
      expect(account.calls).toEqual([`sign_out:${OLD}`, 'signOutHere']);
      expect(q('[data-testid="account-sign-in"]')).not.toBeNull();
    });

    it('a device that signed in during the last 24 hours gets the New device banner; old and this one do not', async () => {
      await mount(connectApi(fakeAccount(SIGNED_IN, list())));
      const banners = document.querySelectorAll('[data-testid="account-new-device"]');
      expect(banners).toHaveLength(1);
      expect(banners[0]!.textContent).toContain('New device');
      expect(banners[0]!.textContent).toContain('Laptop');
      expect(banners[0]!.textContent).toContain('Not me?');
    });

    it('Not me? signs that device out for good and gives the advice', async () => {
      const account = fakeAccount(SIGNED_IN, list());
      await mount(connectApi(account));
      await click(q('[data-testid="account-not-me"]'));
      await settle(8);
      expect(account.calls).toEqual([`not_me:${LAPTOP}`]);
      expect(text('[data-testid="account-not-me-advice"]')).toContain('two-step sign-in');
    });

    it("It's me hides the banner and it stays hidden after the screen is drawn again", async () => {
      await mount(connectApi(fakeAccount(SIGNED_IN, list())));
      await click(q('[data-testid="account-its-me"]'));
      await settle(4);
      expect(q('[data-testid="account-new-device"]')).toBeNull();
      await act(async () => root.unmount());
      root = createRoot(host);
      await mount(connectApi(fakeAccount(SIGNED_IN, list())));
      expect(q('[data-testid="account-new-device"]')).toBeNull();
    });

    it('a device that was signed out is dimmed and has no sign-out button', async () => {
      await mount(connectApi(fakeAccount(SIGNED_IN, [...list(), dev({ id: '44444444-4444-4444-8444-444444444444', name: 'Gone', revoked: true, online: false })])));
      expect(text('[data-testid="account-device-44444444-4444-4444-8444-444444444444"]')).toContain('Signed out');
      expect(q('[data-testid="account-sign-out-44444444-4444-4444-8444-444444444444"]')).toBeNull();
    });
  });
});
