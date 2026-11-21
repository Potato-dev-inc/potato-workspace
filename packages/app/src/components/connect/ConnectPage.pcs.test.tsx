// @vitest-environment jsdom
// Connect > Devices > My PCs, through the real page: PCs of the same account list themselves, Open, Add a PC with one friendly link,
// a PC's own sheet with ONE off-by-default confirmed switch ("Can work on this PC"), the number sheets, and the switched-off state.
// Only the command layers are fakes. Phone words never appear in this group.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { setLanguagePref } from '../../i18n';
import type { AccountApi, AccountPc } from '../../lib/account';
import { click, settle } from '../settings/test-utils';
import { fakeAccount, fakeTunnel, harness, makeApi, q, stable, text, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});

const NOW = Math.floor(Date.now() / 1000);
const pc = (over: Partial<AccountPc>): AccountPc => ({ id: 'x', name: 'REN-LAPTOP', status: 'online', online: true, last_seen_at: NOW, created_at: NOW - 86400 * 30, recent: false, node: NODE_MAC, ...over });
const linked = () => fakeTunnel(stable('linked')).api;

describe('My PCs: the list', () => {
  it('empty: says how a PC shows up, with Add a PC', async () => {
    await h.mount(makeApi({ tunnel: linked() }));
    expect(text('[data-testid="connect-pc-empty"]')).toContain('A PC shows up here when it signs in to your account');
    expect(q('[data-testid="connect-add-pc"]')).not.toBeNull();
  });

  it('PCs of the same account: Open, what to do first, offline with the time seen; the tick row is a plain switch', async () => {
    const account = fakeAccount({
      pcs: [pc({ id: 'a' }), pc({ id: 'b', name: 'REN-WORK', status: 'allow_there', node: null }), pc({ id: 'c', name: 'REN-MINI', status: 'away', online: false, last_seen_at: NOW - 2 * 3600, node: 'd4'.repeat(32) })],
    });
    await h.mount(makeApi({ tunnel: linked(), account }));
    expect(text('[data-testid="account-pc-line-a"]')).toBe('PC · Online');
    expect(q('[data-testid="account-pc-open-a"]')).not.toBeNull();
    expect(text('[data-testid="account-pc-line-b"]')).toBe('PC · Online. Press Allow on REN-WORK first.');
    expect(q('[data-testid="account-pc-open-b"]')).toBeNull();
    expect(text('[data-testid="account-pc-line-c"]')).toBe('PC · Offline, seen 2 h ago');
    expect(q('[data-testid="account-pc-open-c"]')).toBeNull();
    expect(q('[data-testid="connect-pc-group"]')!.textContent).not.toMatch(/phone/i);
  });

  it('Open on an account PC asks the account, then jumps to that PC through the sidebar hook', async () => {
    const opened: string[] = [];
    const base = fakeAccount({ pcs: [pc({ id: 'a' })] });
    const account: AccountApi = { ...base, openPc: async (id) => ({ paired: true, node: `${id}-node`, name: 'REN-LAPTOP', state: 'online' }) };
    await h.mount(makeApi({ tunnel: linked(), account }), 'devices', { onOpenPc: (n) => opened.push(n) });
    await click(q('[data-testid="account-pc-open-a"]'));
    await settle(6);
    expect(opened).toEqual(['a-node']);
  });

  it('a PC asks to be opened but this PC has not said Allow: one plain question with Allow, and Not now hides it', async () => {
    const calls: boolean[] = [];
    const base = fakeAccount({ pcs: [pc({ id: 'a' })], open_here: false });
    const account: AccountApi = { ...base, setOpenHere: async (on) => void calls.push(on) };
    await h.mount(makeApi({ tunnel: linked(), account }));
    expect(text('[data-testid="connect-pc-allow-ask"]')).toContain('Let your other PCs ask to open this PC?');
    await click(q('[data-testid="connect-pc-allow"]'));
    await settle(4);
    expect(calls).toEqual([true]);
    await h.remount(makeApi({ tunnel: linked(), account }));
    await click(q('[data-testid="connect-pc-allow-ask"] .cx-link'));
    expect(q('[data-testid="connect-pc-allow-ask"]')).toBeNull();
    expect(q('[data-testid="account-pcs-tick"]')).not.toBeNull();
  });

  it('a PC that was signed out of the account is announced once, with Dismiss', async () => {
    const dismissed: string[] = [];
    const base = fakeAccount({ pcs: [], removed: [{ id: 'r1', name: 'OLD-PC' }] } as never);
    const account: AccountApi = { ...base, dismissRemoved: async (id) => void dismissed.push(id) };
    await h.mount(makeApi({ tunnel: linked(), account }));
    expect(text('[data-testid="connect-pc-removed-r1"]')).toContain('OLD-PC was removed');
    await click(q('[data-testid="connect-pc-removed-r1"] .cx-link'));
    expect(dismissed).toEqual(['r1']);
  });
});

describe('My PCs: Add a PC', () => {
  it('Make a link copies the link by itself, shows a picture to scan, and says it works from any network when the link is set up', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => (writes.push(s), undefined) }, configurable: true });
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK' });
    await h.mount(makeApi({ tunnel: linked(), devices }));
    await click(q('[data-testid="connect-add-pc"]'));
    expect(q('[data-testid="connect-add-pc-sheet"]')).not.toBeNull();
    await click(q('[data-testid="connect-pc-make-link"]'));
    await settle(8);
    expect(q('[data-testid="connect-pc-link"]')).not.toBeNull();
    expect(writes).toHaveLength(1);
    expect(text('[data-testid="connect-pc-link"]')).toContain('Link copied. Send it to the other PC.');
    expect(q('[data-testid="connect-pc-link-qr"]')).not.toBeNull();
    expect(q('[data-testid="connect-pc-link-near"]') ?? q('[data-testid="connect-pc-link-anywhere"]')).not.toBeNull();
  });

  it('pasting a link from another PC joins it; the sheet shows nothing to type or pick between ways', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK' });
    await h.mount(makeApi({ tunnel: linked(), devices }));
    await click(q('[data-testid="connect-add-pc"]'));
    expect(q('[data-testid="connect-pc-join"]')).toBeNull();
    const input = q<HTMLInputElement>('[data-testid="connect-pc-paste"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'pm1link:somelink');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(q('[data-testid="connect-pc-join"]'));
    await settle(8);
    expect(devices.joinLinks).toEqual(['pm1link:somelink']);
    // It waits for the number check on both PCs (the number sheets): the button says so.
    expect(text('[data-testid="connect-pc-join"]')).toBe('Adding…');
    // No "Show a code", same-network code box, SSH or "More ways" anywhere.
    expect(q('.cx-sheet')!.textContent).not.toMatch(/show a code|ssh|more ways|same network code/i);
  });
});

describe("A PC's own sheet: one switch, off until you say yes", () => {
  const devices = () => new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_run: true, level: 'watch' }, WORK_LAPTOP] });

  it('Can work on this PC is off; turning it on asks first; Yes sets Full, Keep it off changes nothing', async () => {
    const d = devices();
    const set = vi.spyOn(d, 'setPermission');
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    await click(q(`[data-testid="connect-pc-name-${MAC_MINI.node}"]`));
    const sw = q<HTMLInputElement>('[data-testid="connect-pc-work"]')!;
    expect(sw.checked).toBe(false);
    expect(text('[data-testid="connect-pc-sheet"]')).toContain('Can work on this PC');
    expect(text('[data-testid="connect-pc-sheet"]')).toContain('Start agents, use the terminal, change files. Off.');
    await click(sw);
    expect(q('[data-testid="connect-pc-work-confirm"]')!.textContent).toContain('Only do this for a PC you own');
    expect(set).not.toHaveBeenCalled();
    await click(q('[data-testid="connect-pc-work-confirm"] button:not(.cx-primary)'));
    expect(set).not.toHaveBeenCalled();
    await click(sw);
    await click(q('[data-testid="connect-pc-work-yes"]'));
    await settle(6);
    expect(set).toHaveBeenCalledWith(MAC_MINI.node, true, 'full');
    expect(q<HTMLInputElement>('[data-testid="connect-pc-work"]')!.checked).toBe(true);
  });

  it('turning it off goes back to watch, with no question; Remove asks first', async () => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_run: true, level: 'full' }] });
    const set = vi.spyOn(d, 'setPermission');
    const remove = vi.spyOn(d, 'remove');
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    await click(q(`[data-testid="connect-pc-name-${MAC_MINI.node}"]`));
    expect(q<HTMLInputElement>('[data-testid="connect-pc-work"]')!.checked).toBe(true);
    await click(q('[data-testid="connect-pc-work"]'));
    await settle(6);
    expect(set).toHaveBeenCalledWith(MAC_MINI.node, false, 'watch');
    await click(q('[data-testid="connect-pc-remove"]'));
    expect(remove).not.toHaveBeenCalled();
    await click(q('[data-testid="connect-pc-remove-yes"]'));
    await settle(6);
    expect(remove).toHaveBeenCalledWith(MAC_MINI.node);
  });
});

describe('My PCs: the number sheet and the switched-off state', () => {
  it('another PC wants to open this PC: the existing sheet shows, in plain words', async () => {
    const d = new DevicesFake({
      enabled: true,
      name: 'REN-DESK',
      devices: [MAC_MINI],
      pending: { id: 7, role: 'host', name: 'REN-LAPTOP', code: '', expires_at: NOW + 300, mode: 'type', account: { first_seen: NOW - 86400 * 30 } },
    });
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    const sheet = text('[data-testid="pair-confirm"]');
    expect(sheet).toContain('Another PC on your account wants to open this PC');
    expect(sheet).toContain('Never type numbers someone sends you or reads to you.');
    expect(sheet).not.toMatch(/relay|worker|tunnel|\bnode\b|pairing/i);
  });

  it('switched off: one row with a Turn on button that turns it on', async () => {
    const api = makeApi({ tunnel: linked(), settings: { devices_enabled: false }, devices: new DevicesFake({ enabled: false }) });
    await h.mount(api);
    expect(text('[data-testid="connect-pcs-off"]')).toContain('Use more than one PC');
    await click(q('[data-testid="connect-pcs-turn-on"]'));
    await settle(6);
    expect(api.patches).toContainEqual({ devices_enabled: true });
  });
});

describe("A PC's own sheet: only Can work on this PC", () => {
  it('shows the watch line and the one switch; the other switches live in Settings now; off closes shared files', async () => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_run: true, level: 'full', lets_files: true }] });
    const files = vi.spyOn(d, 'setFiles');
    const set = vi.spyOn(d, 'setPermission');
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    await click(q(`[data-testid="connect-pc-name-${MAC_MINI.node}"]`));
    const sheet = text('[data-testid="connect-pc-sheet"]');
    expect(sheet).toContain('It can watch and answer on this PC.');
    expect(sheet).toContain('Can work on this PC');
    expect(sheet).not.toMatch(/browse and copy|borrow my agent|send work/i);
    expect(document.querySelectorAll('[data-testid="connect-pc-sheet"] [role="switch"]')).toHaveLength(1);
    await click(q('[data-testid="connect-pc-work"]'));
    await settle(6);
    expect(set).toHaveBeenCalledWith(MAC_MINI.node, false, 'watch');
    expect(files).toHaveBeenCalledWith(MAC_MINI.node, false);
  });

  it('Open: a hook that has no section for the PC answers false and the PC\'s own sheet opens', async () => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [MAC_MINI] });
    await h.mount(makeApi({ tunnel: linked(), devices: d }), 'devices', { onOpenPc: () => false });
    await click(q(`[data-testid="connect-pc-open-${MAC_MINI.node}"]`));
    await settle(4);
    expect(q('[data-testid="connect-pc-sheet"]')).not.toBeNull();
  });

  it('this PC is never listed among My PCs (its name is not in the list)', async () => {
    const own = 'REN-DESK';
    const account = fakeAccount({ pcs: [pc({ id: 'a', name: 'REN-LAPTOP' })] });
    await h.mount(makeApi({ tunnel: linked(), account, devices: new DevicesFake({ enabled: true, name: own, devices: [MAC_MINI] }) }));
    const names = [...document.querySelectorAll('[data-testid="connect-pc-list"] .cx-name, [data-testid="connect-pc-list"] .cx-namebtn')].map((n) => n.textContent);
    expect(names).not.toContain(own);
    // The shared fixtures never name a PC like the harness's own PC (no two names that differ by a space or a dash).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('../../dev/account-pcs-fixtures').then(({ SAMPLE_PCS }) => {
      const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const keys = SAMPLE_PCS.map((p) => key(p.name));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).not.toContain(key('Desk-PC'));
    });
  });
});

describe('My PCs: Full by default for PCs on your account', () => {
  it('shows "On your account: full access" on a PC paired through the account, and says when you lowered it', async () => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_run: true, level: 'full', account_default: true }, { ...WORK_LAPTOP, lets_run: true, level: 'watch', account_default: true }] });
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    expect(text(`[data-testid="connect-pc-account-${MAC_MINI.node}"]`)).toContain('On your account: full access');
    expect(text(`[data-testid="connect-pc-account-${WORK_LAPTOP.node}"]`)).toContain('you lowered it');
  });

  it('a PC paired before this update gets a one-time card, nothing is raised until Keep, and Lower keeps it as it was', async () => {
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_run: false, level: 'watch', account_card: true }, { ...WORK_LAPTOP, lets_run: false, level: 'watch', account_card: true }] });
    await h.mount(makeApi({ tunnel: linked(), devices: d }));
    expect(text(`[data-testid="connect-pc-account-card-${MAC_MINI.node}"]`)).toContain('Mac mini is on your account. Let it work on this PC?');
    expect(d.view.devices.every((x) => !x.lets_run)).toBe(true);
    await click(q(`[data-testid="connect-pc-account-keep-${MAC_MINI.node}"]`));
    await settle();
    expect(q(`[data-testid="connect-pc-account-card-${MAC_MINI.node}"]`)).toBeNull();
    expect(d.view.devices.find((x) => x.node === MAC_MINI.node)).toMatchObject({ lets_run: true, level: 'full' });
    await click(q(`[data-testid="connect-pc-account-lower-${WORK_LAPTOP.node}"]`));
    await settle();
    expect(q(`[data-testid="connect-pc-account-card-${WORK_LAPTOP.node}"]`)).toBeNull();
    expect(d.view.devices.find((x) => x.node === WORK_LAPTOP.node)).toMatchObject({ lets_run: false });
  });
});

describe('My PCs: old rows and the key note', () => {
  const DAY = 86400;
  const OLD = (over: Partial<AccountPc>) => pc({ id: 'old', name: 'REN', status: 'away', online: false, last_seen_at: NOW - 20 * DAY, node: null, ...over });

  it('PCs not seen for 2 weeks are folded under one line with Show; the 2-day-old one stays', async () => {
    const account = fakeAccount({ pcs: [pc({ id: 'a' }), OLD({}), OLD({ id: 'old2', name: 'REN-2', last_seen_at: NOW - 15 * DAY }), OLD({ id: 'recent', name: 'REN-3', last_seen_at: NOW - 2 * DAY })] });
    await h.mount(makeApi({ tunnel: linked(), account }));
    expect(text('[data-testid="connect-pc-hidden"]')).toContain('Hidden: 2 PCs not seen for 2 weeks.');
    expect(q('[data-testid="account-pc-a"]')).not.toBeNull();
    expect(q('[data-testid="account-pc-recent"]')).not.toBeNull();
    expect(q('[data-testid="account-pc-old"]')).toBeNull();
    await click(q('[data-testid="connect-pc-hidden-toggle"]'));
    expect(q('[data-testid="account-pc-old"]')).not.toBeNull();
    expect(q('[data-testid="account-pc-old2"]')).not.toBeNull();
    expect(text('[data-testid="connect-pc-hidden-toggle"]')).toBe('Hide');
  });

  it('nothing is folded when every PC was seen lately', async () => {
    await h.mount(makeApi({ tunnel: linked(), account: fakeAccount({ pcs: [pc({ id: 'a' }), OLD({ id: 'r', last_seen_at: NOW - 3 * DAY })] }) }));
    expect(q('[data-testid="connect-pc-hidden"]')).toBeNull();
  });

  it('Remove on an offline PC asks first, then signs that device out of the account; an online PC has no Remove', async () => {
    const calls: string[] = [];
    const base = fakeAccount({ pcs: [pc({ id: 'a' }), OLD({ id: 'r', last_seen_at: NOW - 3 * DAY })] });
    const account: AccountApi = { ...base, revoke: async (id, action) => (calls.push(`${action}:${id}`), { signed_in: true, devices: [] }) };
    await h.mount(makeApi({ tunnel: linked(), account }));
    expect(q('[data-testid="account-pc-remove-a"]')).toBeNull();
    await click(q('[data-testid="account-pc-remove-r"]'));
    expect(text('[data-testid="account-pc-line-r"]')).toBe('Sign REN out of your account?');
    expect(calls).toEqual([]);
    await click(q('[data-testid="account-pc-remove-yes-r"]'));
    await settle(6);
    expect(calls).toEqual(['sign_out:r']);
  });

  it('a list made with a key this PC no longer has says so; a damaged list keeps the old sentence', async () => {
    const devices = new DevicesFake({ enabled: true, name: 'REN-DESK' });
    devices.view = { ...devices.view, tampered: true, key_changed: true };
    await h.mount(makeApi({ tunnel: linked(), devices }));
    expect(text('[data-testid="connect-pc-tampered"]')).toContain("This PC's key was reset");
    await h.unmount();
    h = harness();
    const damaged = new DevicesFake({ enabled: true, name: 'REN-DESK' });
    damaged.view = { ...damaged.view, tampered: true };
    await h.mount(makeApi({ tunnel: linked(), devices: damaged }));
    expect(text('[data-testid="connect-pc-tampered"]')).toBe('The list of PCs could not be trusted. Add your PCs again.');
  });
});
