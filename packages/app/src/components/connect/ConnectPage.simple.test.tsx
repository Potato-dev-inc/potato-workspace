// @vitest-environment jsdom
// Connect > Phone, the default view, through the real ConnectPage: one line, one code, one status line, nothing to choose.
// Only the command layers are fakes (settings, paired phones, the tunnel commands, the pairing code, the address watch).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_CAPS, type PairedDeviceInfo, type Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import { en } from '../../i18n/en';
import { zhTW } from '../../i18n/zh-TW';
import { OFFER_SNOOZE_MS, offerSnoozed } from '../../lib/connect-offer';
import { setLanguagePref } from '../../i18n';
import type { PublicBridgeDevInfo } from '../../lib/public-bridge-url';
import { tauri } from '../../lib/tauri';
import type { TeamApi } from '../../lib/team';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';
import { DEVICES_CHANGED_EVENT } from '../MobilePairingPanel';
import { ConnectPage, type ConnectApi } from './ConnectPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));
const watch = vi.hoisted(() => ({ current: null as PublicBridgeDevInfo | null, push: null as ((i: PublicBridgeDevInfo | null) => void) | null }));
vi.mock('../../lib/load-tunnel-dev-info', () => ({
  watchTunnelDevInfo: (cb: (i: PublicBridgeDevInfo | null) => void) => {
    watch.push = cb;
    cb(watch.current);
    return () => {
      watch.push = null;
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

const infoFor = (host: string): PublicBridgeDevInfo => ({ bridgeProxyUrl: 'http://127.0.0.1:1/bridge', tunnelUrl: `https://${host}.trycloudflare.com`, localUrl: 'http://127.0.0.1:1420' });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  watch.current = infoFor('quick-one');
  vi.spyOn(tauri, 'createMobilePairingSession').mockImplementation(async (bridgeUrl) => ({
    pairing_code: 'K7Q2M9XD',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    server_public_key: 'a2V5',
    bridge_url: bridgeUrl,
    qr_payload: { v: 1, u: bridgeUrl, pk: 'a2V5', c: 'K7Q2M9XD', e: Math.floor(Date.now() / 1000) + 600 },
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

const PHONE = { id: 'p1', name: "Ren's iPhone", created_at: 1, last_seen: 1, expired: false } as unknown as PairedDeviceInfo;

const quick = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  mode: 'quick',
  public_url: 'https://quick-one.trycloudflare.com',
  state: 'running',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
  ...over,
});
const WORKER = 'https://pm-relay.maya.workers.dev';
const stable = (link: 'linked' | 'failed' | 'linking'): TunnelStatus => ({
  mode: 'stable',
  public_url: WORKER,
  state: 'running',
  error: null,
  config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
  stable: { worker_url: WORKER, quick_url: 'https://quick-one.trycloudflare.com', link, error: link === 'failed' ? 'The link was refused.' : null },
});

function fakeTunnel(first: TunnelStatus, onRestart?: (n: number) => TunnelStatus) {
  let current = first;
  let restarts = 0;
  const api: TunnelApi = {
    getStatus: async () => current,
    save: async () => current,
    restart: async () => {
      restarts += 1;
      if (onRestart) current = onRestart(restarts);
      return current;
    },
    test: async () => ({ ok: true, url: '', http_status: 200, latency_ms: 1, message: 'ok' }),
  };
  return { api, restarts: () => restarts };
}

function makeApi(tunnel: TunnelApi, phones: PairedDeviceInfo[] = [], settings: Partial<Settings> = {}): Partial<ConnectApi> {
  const state = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true, ...settings } as Settings;
  const team = {
    state: async () => teamState({ active: false, presence: [] }),
    configGet: async () => teamConfig({ team: '' }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
  return {
    loadSettings: async () => state,
    patchSettings: async () => state,
    listPhones: async () => phones,
    devices: new DevicesFake({ enabled: true }),
    team,
    lend: createFakeLendApi(lendState({ grants: [] })),
    tunnel,
  };
}

async function mount(api: Partial<ConnectApi>, tab: 'phone' | 'team' = 'phone') {
  await act(async () => root.render(<ConnectPage tab={tab} onTab={() => undefined} api={api} />));
  await settle(10);
}
async function remount(api: Partial<ConnectApi>, tab: 'phone' | 'team' = 'phone') {
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount(api, tab);
}

/** The page's own words, with every closed "Advanced" and "Show details" folded away. */
function defaultViewText(): string {
  const clone = q('[data-testid="connect-page"]')!.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('details').forEach((d) => d.remove());
  return clone.textContent ?? '';
}

const FORBIDDEN = /worker|tunnel|token|\bports?\b|secret|durable/i;

describe('Connect > Phone, default view', () => {
  it('shows one line, one code and one status line, with nothing to choose or type', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(text('[data-testid="connect-simple-lead"]')).toBe('Scan this with your phone camera.');
    expect(q('[data-testid="connect-qr"]')).not.toBeNull();
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(false);
    expect(text('[data-testid="connect-simple-status"]')).toBe('Ready.');
    const page = q('[data-testid="connect-simple"]')!;
    expect(page.querySelectorAll('input, select, textarea')).toHaveLength(0);
    // The only button is Copy link (no pm1:/pm2: text is shown).
    expect([...page.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy link']);
    expect(page.textContent).not.toMatch(/pm[12]:/);
    // The code was made against the quick address, without being asked.
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![0]).toContain('quick-one.trycloudflare.com');
  });

  it('says "Phone connected." once a phone is paired', async () => {
    await mount(makeApi(fakeTunnel(quick()).api, [PHONE]));
    expect(text('[data-testid="connect-simple-status"]')).toBe('Phone connected.');
  });

  it('never shows Worker, tunnel, token, port, secret or Durable Object in the default view (ready or problem)', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(defaultViewText()).not.toMatch(FORBIDDEN);
    await remount(makeApi(fakeTunnel(quick({ state: 'error', error: 'cloudflared exited', problem: 'rate_limited' })).api));
    expect(q('[data-testid="connect-problem"]')).not.toBeNull();
    expect(defaultViewText()).not.toMatch(FORBIDDEN);
  });

  it('the zh-TW default view (ready and problem) has none of the technical words either', async () => {
    setLanguagePref('zh-TW', false);
    const ZH = /worker|tunnel|token|port|secret|durable|通道|權杖|令牌|密鑰|連接埠|中繼/i;
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(text('[data-testid="connect-simple-caps"]')).toBe('這支手機可以查看、回答與傳送訊息。之後你可以再開放更多權限。');
    expect(defaultViewText()).not.toMatch(ZH);
    await remount(makeApi(fakeTunnel(quick({ state: 'error', error: 'x', problem: 'too_soon', retry_in_secs: 60 })).api));
    expect(q('[data-testid="connect-problem"]')).not.toBeNull();
    expect(defaultViewText()).not.toMatch(ZH);
  });

  it('guards every default-view string, in English and Traditional Chinese', () => {
    const keys = Object.keys(en).filter((k) => /^connect\.(simple|offer)\./.test(k));
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) {
      expect((en as Record<string, string>)[k], k).not.toMatch(FORBIDDEN);
      const zh = (zhTW as Record<string, string | undefined>)[k];
      expect(zh, `zh-TW is missing ${k}`).toBeTruthy();
      expect(zh, k).not.toMatch(FORBIDDEN);
      // Traditional Chinese uses full-width punctuation.
      expect(zh, k).not.toMatch(/[,!?;](?!\d)/);
    }
  });

  it('the automatic code allows watch, answer and send messages, says so, and one tap in Advanced allows control', async () => {
    const device = { id: 'p1', name: "Ren's iPhone", created_at: 1, last_seen: 1, expired: false, caps: ['watch', 'answer', 'type'] } as unknown as PairedDeviceInfo;
    vi.spyOn(tauri, 'listPairedMobileDevices').mockResolvedValue([device]);
    const setCaps = vi.spyOn(tauri, 'setPairedMobileDeviceCaps').mockResolvedValue(undefined as never);
    await mount(makeApi(fakeTunnel(quick()).api, [PHONE]));
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![1]).toEqual(['watch', 'answer', 'type']);
    expect(text('[data-testid="connect-simple-caps"]')).toBe('This phone can watch, answer and send messages. You can allow more later.');
    // The one switch still off is "Start tasks" (control): it is never on by default.
    const off = [...q('[data-testid="connect-phones"]')!.querySelectorAll<HTMLElement>('[role="switch"]')].find((sw) => sw.getAttribute('aria-checked') === 'false')!;
    await click(off);
    await settle(4);
    expect(setCaps).toHaveBeenCalledTimes(1);
    expect(setCaps.mock.calls[0]![1] as string[]).toEqual(['watch', 'answer', 'type', 'control']);
    expect(DEVICE_CAPS.length).toBeGreaterThan(2);
  });

  it('a far-off expiry does not make codes in a loop (the renew timer is capped)', async () => {
    vi.mocked(tauri.createMobilePairingSession).mockImplementation(async (bridgeUrl) => ({
      pairing_code: 'K7Q2M9XD',
      expires_at: 4_000_000_000,
      server_public_key: 'a2V5',
      bridge_url: bridgeUrl,
      qr_payload: { v: 1, u: bridgeUrl, pk: 'a2V5', c: 'K7Q2M9XD', e: 4_000_000_000 },
    }));
    await mount(makeApi(fakeTunnel(quick()).api));
    await settle(30);
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
  });

  it('while Pair a phone is open in Advanced, the simple code stops and hides; it comes back when closed', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    await click(q('[data-testid="connect-main-phone"]'));
    await settle(6);
    expect(text('[data-testid="connect-simple-paused"]')).toBe('Pair a phone is open below.');
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(true);
    expect(q('[data-testid="connect-copy-link"]')).toBeNull();
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    await click(q('[data-testid="connect-main-phone"]'));
    await settle(8);
    expect(q('[data-testid="connect-simple-paused"]')).toBeNull();
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(false);
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(2);
  });

  it('a new phone pairs: the spent code is replaced by a fresh one for the next phone', async () => {
    const phones: PairedDeviceInfo[] = [];
    await mount(makeApi(fakeTunnel(quick()).api, phones));
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    phones.push(PHONE);
    await act(async () => window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)));
    await settle(10);
    expect(text('[data-testid="connect-simple-status"]')).toBe('Phone connected.');
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(2);
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(false);
  });

  it('codes are made only while the window is looked at: hidden or blurred stops them and hides the code', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event('blur')));
    await settle(4);
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(true);
    expect(text('[data-testid="connect-qr-away"]')).toBe('Click to show again');
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(1);
    // Back in the window: a fresh code.
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(8);
    expect(q('[data-testid="connect-qr-away"]')).toBeNull();
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(2);
    // Hidden tab, then the click.
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle(4);
    expect(q('[data-testid="connect-qr-away"]')).not.toBeNull();
    state.mockReturnValue('visible');
    await click(q('[data-testid="connect-qr-away"]'));
    await settle(8);
    expect(q('[data-testid="connect-qr-away"]')).toBeNull();
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(3);
  });

  it('Advanced is closed by default and still holds every old control, each with a plain line', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    const adv = q<HTMLDetailsElement>('[data-testid="connect-advanced"]')!;
    expect(adv.open).toBe(false);
    for (const id of ['connect-main-phone', 'connect-address', 'connect-phones', 'connect-phone-more', 'connect-telegram', 'connect-relay', 'connect-status-phone']) {
      expect(adv.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(adv.querySelectorAll('.cn-adv-term')).toHaveLength(6);
    expect(text('[data-testid="connect-adv-terms"]')).toContain('The private path between your phone and your PC.');
    await click(q('[data-testid="connect-main-phone"]'));
    expect(q('[data-testid="pairing-panel"]')).not.toBeNull();
    await click(q('[data-testid="connect-address"]'));
    await settle(6);
    expect(q('[data-testid="tunnel-stub"]')).not.toBeNull();
  });

  it('a fixed address that fails falls back to the quick one and says so', async () => {
    await mount(makeApi(fakeTunnel(stable('failed')).api));
    expect(text('[data-testid="connect-simple-temp"]')).toBe('Using a temporary address for now.');
    expect(text('[data-testid="connect-simple-status"]')).toBe('Ready.');
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![0]).toContain('quick-one.trycloudflare.com');
  });

  it('a linked fixed address is always used, with no fallback line', async () => {
    await mount(makeApi(fakeTunnel(stable('linked')).api));
    expect(q('[data-testid="connect-simple-temp"]')).toBeNull();
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![0]).toBe(`${WORKER}/bridge`);
  });

  it('a problem is one plain line and Fix it; the technical message is folded; a second try can work', async () => {
    const bad = () => quick({ state: 'error', error: 'cloudflared exited with code 1' });
    const t = fakeTunnel(bad(), (n) => (n >= 2 ? quick() : bad()));
    await mount(makeApi(t.api));
    expect(text('[data-testid="connect-simple-status"]')).toBe("Your phone can't reach this PC.");
    expect(q('[data-testid="connect-qr"]')!.closest('.cn-qr')!.hasAttribute('hidden')).toBe(true);
    const details = q<HTMLDetailsElement>('[data-testid="connect-problem-details"]')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('cloudflared exited with code 1');
    expect(defaultViewText()).not.toContain('cloudflared');
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    expect(t.restarts()).toBe(1);
    expect(q('[data-testid="connect-problem"]')).not.toBeNull();
    await click(q('[data-testid="connect-fix"]'));
    await settle(8);
    expect(t.restarts()).toBe(2);
    expect(q('[data-testid="connect-problem"]')).toBeNull();
    expect(text('[data-testid="connect-simple-status"]')).toBe('Ready.');
  });

  it('Fix it respects the wait: a refused restart shows "Try again in about N min"', async () => {
    const refused = quick({ state: 'error', error: 'Too soon.', problem: 'too_soon', retry_in_secs: 300 });
    const t = fakeTunnel(refused, () => refused);
    await mount(makeApi(t.api));
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    expect(text('[data-testid="connect-backoff"]')).toBe('Try again in about 5 min.');
    expect(q('[data-testid="connect-problem-details"]')!.textContent).toContain('Too soon.');
  });

  it('the rate-limit case shows its own plain sentence', async () => {
    await mount(makeApi(fakeTunnel(quick({ state: 'error', error: 'rate', problem: 'rate_limited' })).api));
    expect(text('[data-testid="connect-backoff"]')).toBe('Your network is limited for now. Try again in about an hour.');
  });

  it('after 3 tries it asks the agent instead', async () => {
    const bad = quick({ state: 'error', error: 'still down' });
    const t = fakeTunnel(bad, () => bad);
    await mount(makeApi(t.api));
    for (let i = 0; i < 3; i++) {
      await click(q('[data-testid="connect-fix"]'));
      await settle(6);
    }
    expect(t.restarts()).toBe(3);
    expect(q('[data-testid="connect-fix"]')).toBeNull();
    expect(text('[data-testid="connect-ask-agent"]')).toBe('Ask the agent to fix this.');
  });

  it('speaks Traditional Chinese', async () => {
    setLanguagePref('zh-TW', false);
    await mount(makeApi(fakeTunnel(quick()).api));
    expect(text('[data-testid="connect-simple-lead"]')).toBe('用手機相機掃描這個代碼。');
    expect(text('[data-testid="connect-simple-status"]')).toBe('已就緒。');
  });
});

describe('the one extra offer', () => {
  it('never shows before the first scan has worked, even after the quick address changes', async () => {
    await mount(makeApi(fakeTunnel(quick()).api));
    await act(async () => watch.push!(infoFor('quick-two')));
    await settle(6);
    expect(q('[data-testid="connect-offer"]')).toBeNull();
  });

  it('a phone drops because the quick address changed: "Scan again.", a new code, and one quiet card', async () => {
    const api = makeApi(fakeTunnel(quick()).api, [PHONE]);
    await mount(api);
    expect(text('[data-testid="connect-simple-status"]')).toBe('Phone connected.');
    expect(q('[data-testid="connect-offer"]')).toBeNull();
    await act(async () => watch.push!(infoFor('quick-two')));
    await settle(8);
    expect(text('[data-testid="connect-simple-status"]')).toBe('Scan again.');
    expect(tauri.createMobilePairingSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[1]![0]).toContain('quick-two.trycloudflare.com');
    expect(text('[data-testid="connect-offer"]')).toContain('Keep the same link every time. One-time setup, about 2 minutes, free.');
  });

  it('Not now hides the card and remembers it for about 14 days', async () => {
    const api = makeApi(fakeTunnel(quick()).api, [PHONE]);
    await mount(api);
    await act(async () => watch.push!(infoFor('quick-two')));
    await settle(8);
    await click(q('[data-testid="connect-offer-later"]'));
    await settle(4);
    expect(q('[data-testid="connect-offer"]')).toBeNull();
    expect(offerSnoozed()).toBe(true);
    expect(offerSnoozed(Date.now() + OFFER_SNOOZE_MS + 1000)).toBe(false);
    // Another address change later in the same snooze: no card.
    await act(async () => watch.push!(infoFor('quick-three')));
    await settle(8);
    expect(q('[data-testid="connect-offer"]')).toBeNull();
  });

  it('Set it up opens the one-button relay setup', async () => {
    window.localStorage.setItem('pm.connect.firstScanWorked', '1');
    await mount(makeApi(fakeTunnel(quick()).api), 'team');
    await click(q('[data-testid="connect-offer-set"]'));
    await settle(6);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('Team: no offer before the first scan worked; after it, only the first time Team opens', async () => {
    await mount(makeApi(fakeTunnel(quick()).api), 'team');
    expect(q('[data-testid="connect-offer"]')).toBeNull();
    window.localStorage.setItem('pm.connect.firstScanWorked', '1');
    await remount(makeApi(fakeTunnel(quick()).api), 'team');
    expect(q('[data-testid="connect-offer"]')).not.toBeNull();
    await remount(makeApi(fakeTunnel(quick()).api), 'team');
    expect(q('[data-testid="connect-offer"]')).toBeNull();
  });

  it('Team: not offered when a fixed address is already set up', async () => {
    window.localStorage.setItem('pm.connect.firstScanWorked', '1');
    await mount(makeApi(fakeTunnel(stable('linked')).api), 'team');
    expect(q('[data-testid="connect-offer"]')).toBeNull();
  });
});
