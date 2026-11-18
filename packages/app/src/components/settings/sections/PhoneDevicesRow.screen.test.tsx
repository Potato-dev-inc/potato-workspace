// @vitest-environment jsdom
// Settings > Advanced > Connections to other tools > "Phone and other devices": the real row, with the REAL link-options screen
// (TunnelSection) and the real phone rows. Connect no longer shows these, so this test proves nothing was lost by the move:
// phone alerts, keyboard, typing box, sign out every phone (confirmed), Telegram (early feature) and every link mode (own domain etc.).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from '../catalog';
import { buttonByText, click, mountRows, settle, type Mounted } from '../test-utils';
import { phoneDevicesRow } from './PhoneSection';
import { resolveSettingsTarget } from '../../../lib/settings-target';

const mocks = vi.hoisted(() => ({ revoked: [] as string[] }));

vi.mock('../../../lib/tauri', () => ({
  tauri: {
    listPairedMobileDevices: vi.fn(async () => [{ id: 'p1', name: "Ren's iPhone", public_key: 'k', paired_at: 1, caps: ['watch'], expires_at: 9e9, last_seen: 1, expired: false }]),
    revokePairedMobileDevice: vi.fn(async (id: string) => (mocks.revoked.push(id), true)),
    getTunnelStatus: vi.fn(async () => ({ mode: 'quick', public_url: 'https://abc.trycloudflare.com', state: 'running', error: null, config: { mode: 'quick', hostname: null, url: null, has_token: false } })),
    setTunnelConfig: vi.fn(),
    restartTunnel: vi.fn(),
    testTunnelConnection: vi.fn(),
    getMobileTunnelInfo: vi.fn(async () => ({ tunnelUrl: null, bridgeProxyUrl: '', localUrl: 'http://127.0.0.1:1420' })),
  },
}));
vi.mock('../blocks/TelegramSetup', async () => {
  const { createElement } = await import('react');
  return { TelegramSetup: () => createElement('p', { 'data-testid': 'telegram-real' }, 'Telegram setup') };
});

let m: Mounted;
beforeEach(() => {
  mocks.revoked.length = 0;
});
afterEach(async () => {
  await m?.unmount();
});

describe('Settings > Advanced > Phone and other devices', () => {
  it('is a real row of the Advanced page, inside "Connections to other tools"', () => {
    const adv = SECTIONS.find((s) => s.id === 'advanced')!;
    const row = adv.rows.find((r) => r.id === 'phone-devices');
    expect(row).toBeTruthy();
    expect(row!.group).toBe('Connections to other tools');
  });

  it('holds phone alerts, keyboard, typing box, sign out every phone, Telegram and the link modes', async () => {
    m = await mountRows([phoneDevicesRow]);
    for (let i = 0; i < 40 && !m.host.querySelector('select[aria-label="Tunnel mode"]'); i++) await new Promise((r) => setTimeout(r, 25)).then(() => settle(2));
    const t = m.host.textContent ?? '';
    expect(t).toContain('Phone alerts');
    expect(t).toContain('Keyboard resizes the agent');
    expect(t).toContain('Show the typing box on the phone');
    expect(t).toContain('Revoke all devices');
    expect(m.host.querySelector('[data-testid="telegram-real"]')).not.toBeNull();
    // The real link screen: the mode choice offers automatic, a named tunnel and an own domain.
    const modes = m.host.querySelector<HTMLSelectElement>('select[aria-label="Tunnel mode"]');
    expect(modes).not.toBeNull();
    const labels = [...modes!.options].map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Automatic (changes on restart)', 'My Cloudflare tunnel', 'My own domain or proxy']));
  });

  it('Revoke all devices asks first, then signs out every phone', async () => {
    m = await mountRows([phoneDevicesRow]);
    await settle(8);
    await click(buttonByText(m.host, 'Revoke…'));
    await settle(8);
    // It asked first (the row's own confirm), and only then signed the phone out.
    expect(m.env.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.revoked).toEqual(['p1']);
  });
});

describe('Old deep links land on that row, not on Connect', () => {
  it.each(['telegram', 'tunnel', 'revoke-all-devices', 'phone-notifications', 'mobile-keyboard-resizes', 'mobile-input-visible'])('%s', (id) => {
    expect(resolveSettingsTarget(id)).toEqual({ page: 'advanced', row: 'phone-devices' });
  });
  it('the pairing and phone words still open Connect > Devices', () => {
    expect(resolveSettingsTarget('mobile')).toEqual({ page: 'connect', connectTab: 'devices' });
  });
});

describe('Settings search still finds the phone settings', () => {
  it.each(['telegram', 'revoke', 'keyboard', 'own domain'])('"%s" finds the Phone and other devices row', async (word) => {
    const { searchAll } = await import('../search');
    const found = searchAll(SECTIONS, word).hits.flatMap((h) => h.rows.map((r) => (r as { id?: string; row?: { id: string } }).id ?? (r as { row?: { id: string } }).row?.id));
    expect(found).toContain('phone-devices');
  });
});

describe('Phone and other devices > My PCs (what the Connect PC sheet no longer holds)', () => {
  it('lists each paired PC with files, borrow sign-ins and send-work switches that use the same commands', async () => {
    const { DevicesFake, MAC_MINI } = await import('../../../dev/devices-fixtures');
    const { PhoneDevicesPcs } = await import('./PhoneDevicesPcs');
    const { createElement } = await import('react');
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const d = new DevicesFake({ enabled: true, name: 'REN-DESK', devices: [{ ...MAC_MINI, lets_files: false }] });
    const files = vi.spyOn(d, 'setFiles');
    const lend = vi.spyOn(d, 'setLend');
    const send = vi.spyOn(d, 'setAgentsSend');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PhoneDevicesPcs, { api: d })));
    await settle(10);
    const t = host.textContent ?? '';
    expect(t).toContain('My PCs');
    expect(t).toContain('Mac mini');
    expect(t).toContain('Can browse and copy my files');
    expect(t).toContain('Can ask to borrow my agent sign-ins');
    expect(t).toContain('My agents can send work to it');
    const sw = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"] [role="switch"]`)!;
    await click(sw('settings-pc-files'));
    await click(sw('settings-pc-lend'));
    await click(sw('settings-pc-send'));
    await settle(6);
    expect(files).toHaveBeenCalledWith(MAC_MINI.node, true);
    expect(lend).toHaveBeenCalledWith(MAC_MINI.node, true);
    expect(send).toHaveBeenCalledWith(MAC_MINI.node, true);
    await act(async () => root.unmount());
    host.remove();
  });
});

describe('Sheet buttons never touch', () => {
  it('the number sheet keeps its buttons in a wrapping row with a gap, and the label is short', async () => {
    const fs = await import('node:fs');
    const css = fs.readFileSync('src/styles/devices.css', 'utf8');
    expect(css).toMatch(/\.dev-sheet \.dev-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*gap:\s*8px/);
    expect(css).toMatch(/\.dev-actions \.dev-btn\s*\{[^}]*white-space:\s*nowrap/);
    const { en } = await import('../../../i18n/en');
    const { zhTW } = await import('../../../i18n/zh-TW');
    expect(en['account.pair.typeGo']).toBe('Check');
    expect((zhTW as Record<string, string>)['account.pair.typeGo']).toBe('核對');
  });
});
