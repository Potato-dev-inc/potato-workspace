// @vitest-environment jsdom
// Connect > Devices > My phone, through the real page: the giant code is the hero while no phone is added, one code at a time, a phone's
// own sheet (rename, the one switch for starting agents, Remove), and the code's fix-it path. Only the command layers are fakes.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDeviceInfo } from '@potato-workspace/shared';
import { setLanguagePref } from '../../i18n';
import type { PublicBridgeDevInfo } from '../../lib/public-bridge-url';
import { tauri } from '../../lib/tauri';
import { DEVICES_CHANGED_EVENT } from '../MobilePairingPanel';
import { click, settle } from '../settings/test-utils';
import type { PhoneApi } from './PhoneGroup';
import { fakeTunnel, harness, makeApi, PHONE, q, quick, stable, text, WORKER, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));
const watch = vi.hoisted(() => ({ current: null as PublicBridgeDevInfo | null }));
vi.mock('../../lib/load-tunnel-dev-info', () => ({
  watchTunnelDevInfo: (cb: (i: PublicBridgeDevInfo | null) => void) => {
    cb(watch.current);
    return () => undefined;
  },
}));

const infoFor = (host: string): PublicBridgeDevInfo => ({ bridgeProxyUrl: 'http://127.0.0.1:1/bridge', tunnelUrl: `https://${host}.trycloudflare.com`, localUrl: 'http://127.0.0.1:1420' });

let h: Harness;
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
  h = harness();
});
afterEach(async () => {
  await h.unmount();
});

const made = () => vi.mocked(tauri.createMobilePairingSession).mock.calls.length;

describe('My phone: the giant code', () => {
  it('no phone: one line, one giant code in the middle, nothing to choose or type', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(text('[data-testid="connect-simple-lead"]')).toBe('Scan this with your phone camera.');
    const hero = q('[data-testid="connect-phone-hero"]')!;
    expect(hero.querySelector('canvas[data-testid="connect-qr"]')).not.toBeNull();
    expect(hero.querySelector('.cn-simple--giant')).not.toBeNull();
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(false);
    expect(text('[data-testid="connect-simple-caps"]')).toBe('Your phone shows up here by itself. It can watch, answer and send messages. You can allow more later.');
    const page = q('[data-testid="connect-simple"]')!;
    expect(page.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect([...page.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy link']);
    expect(page.textContent).not.toMatch(/pm[12]:/);
    expect(made()).toBe(1);
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![0]).toContain('quick-one.trycloudflare.com');
    // The code lets a phone watch, answer and send messages; starting things is never on by default.
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![1]).toEqual(['watch', 'answer', 'type']);
  });

  it('a phone is added: the hero gives way to the phone row, and a fresh code is only made inside the Add a phone sheet', async () => {
    const phones: PairedDeviceInfo[] = [];
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api, phones }));
    expect(made()).toBe(1);
    phones.push(PHONE);
    await act(async () => window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)));
    await settle(10);
    expect(q('[data-testid="connect-phone-hero"]')).toBeNull();
    expect(text('[data-testid="connect-phone-group"]')).toContain("Ren's iPhone");
    await click(q('[data-testid="connect-add-phone"]'));
    await settle(8);
    expect(q('[data-testid="connect-add-phone-sheet"] canvas[data-testid="connect-qr"]')).not.toBeNull();
    expect(made()).toBeGreaterThanOrEqual(2);
  });

  it('no code is made while another tab is open (the Devices tab is not on screen)', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }), 'team');
    expect(made()).toBe(0);
    expect(q('[data-testid="connect-phone-group"]')).toBeNull();
  });

  it('a far-off expiry does not make codes in a loop (the renew timer is capped)', async () => {
    vi.mocked(tauri.createMobilePairingSession).mockImplementation(async (bridgeUrl) => ({
      pairing_code: 'K7Q2M9XD',
      expires_at: 4_000_000_000,
      server_public_key: 'a2V5',
      bridge_url: bridgeUrl,
      qr_payload: { v: 1, u: bridgeUrl, pk: 'a2V5', c: 'K7Q2M9XD', e: 4_000_000_000 },
    }));
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    await settle(30);
    expect(made()).toBe(1);
  });

  it('codes are made only while the window is looked at: blurred stops them and hides the code, coming back makes a fresh one', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(made()).toBe(1);
    await act(async () => window.dispatchEvent(new Event('blur')));
    await settle(4);
    expect(q('.cn-qr')!.hasAttribute('hidden')).toBe(true);
    expect(text('[data-testid="connect-qr-away"]')).toBe('Click to show again');
    expect(made()).toBe(1);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(8);
    expect(q('[data-testid="connect-qr-away"]')).toBeNull();
    expect(made()).toBe(2);
  });

  it('a link that fails falls back to the quick one and says so; a linked one is always used', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed')).api }));
    expect(text('[data-testid="connect-simple-temp"]')).toBe('Using a link that can change for now.');
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls[0]![0]).toContain('quick-one.trycloudflare.com');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(q('[data-testid="connect-simple-temp"]')).toBeNull();
    expect(vi.mocked(tauri.createMobilePairingSession).mock.calls.at(-1)![0]).toBe(`${WORKER}/bridge`);
  });
});

describe('My phone: when the code cannot be made', () => {
  it('one plain line and Fix it; no folded technical text anywhere; a second try can work', async () => {
    const bad = () => quick({ state: 'error', error: 'cloudflared exited with code 1' });
    const t = fakeTunnel(bad(), (n) => (n >= 2 ? quick() : bad()));
    await h.mount(makeApi({ tunnel: t.api }));
    expect(text('[data-testid="connect-simple-status"]')).toBe("Your phone can't reach this PC.");
    expect(q('[data-testid="connect-qr"]')!.closest('.cn-qr')!.hasAttribute('hidden')).toBe(true);
    expect(q('[data-testid="connect-problem-details"]')).toBeNull();
    expect(q('[data-testid="connect-page"]')!.textContent).not.toContain('cloudflared');
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    expect(t.calls.restart).toBe(1);
    await click(q('[data-testid="connect-fix"]'));
    await settle(8);
    expect(t.calls.restart).toBe(2);
    expect(q('[data-testid="connect-problem"]')).toBeNull();
  });

  it('Fix it respects the wait, the limit has its own sentence, and after 3 tries it asks the agent', async () => {
    const refused = quick({ state: 'error', error: 'Too soon.', problem: 'too_soon', retry_in_secs: 300 });
    const t = fakeTunnel(refused, () => refused);
    await h.mount(makeApi({ tunnel: t.api }));
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    expect(text('[data-testid="connect-backoff"]')).toBe('Try again in about 5 min.');
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    await click(q('[data-testid="connect-fix"]'));
    await settle(6);
    expect(t.calls.restart).toBe(3);
    expect(q('[data-testid="connect-fix"]')).toBeNull();
    expect(text('[data-testid="connect-ask-agent"]')).toBe('Ask the agent to fix this.');
    await h.remount(makeApi({ tunnel: fakeTunnel(quick({ state: 'error', error: 'rate', problem: 'rate_limited' })).api }));
    expect(text('[data-testid="connect-backoff"]')).toBe('Your network is limited for now. Try again in about an hour.');
  });
});

describe("A phone's own sheet", () => {
  function phoneApi() {
    const calls: unknown[][] = [];
    const api: PhoneApi = {
      setCaps: async (...a) => void calls.push(['caps', ...a]),
      rename: async (...a) => void calls.push(['rename', ...a]),
      revoke: async (...a) => void calls.push(['revoke', ...a]),
    };
    return { api, calls };
  }

  it('shows the name, what it can do and one switch for starting agents (off); turning it on asks first', async () => {
    const p = phoneApi();
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], phoneApi: p.api }));
    await click(q('.cx-namebtn'));
    const sheet = q('[data-testid="connect-phone-sheet"]')!;
    expect(q<HTMLInputElement>('[data-testid="connect-phone-level-send"]')!.checked).toBe(true);
    expect(sheet.textContent).toContain('Watch, answer and send messages');
    const sw = q<HTMLInputElement>('[data-testid="connect-phone-more"]')!;
    expect(sw.checked).toBe(false);
    await click(sw);
    expect(q('[data-testid="connect-phone-more-confirm"]')!.textContent).toContain('Only do this for your own phone');
    expect(p.calls).toEqual([]);
    await click(q('[data-testid="connect-phone-more-yes"]'));
    await settle(4);
    expect(p.calls).toEqual([['caps', 'p1', ['watch', 'answer', 'type', 'control']]]);
  });

  it('Keep it off changes nothing; Remove asks first, then removes', async () => {
    const p = phoneApi();
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [PHONE], phoneApi: p.api }));
    await click(q('.cx-namebtn'));
    await click(q('[data-testid="connect-phone-more"]'));
    await click(q('[data-testid="connect-phone-more-confirm"] button:not(.cx-primary)'));
    expect(p.calls).toEqual([]);
    await click(q('[data-testid="connect-phone-remove"]'));
    expect(q('[data-testid="connect-phone-remove-confirm"]')).not.toBeNull();
    expect(p.calls).toEqual([]);
    await click(q('[data-testid="connect-phone-remove-yes"]'));
    await settle(4);
    expect(p.calls).toEqual([['revoke', 'p1']]);
  });
});

describe("A phone's own sheet: what it can do", () => {
  it('a plain level choice lowers the phone to watch only and keeps the start-agents switch separate', async () => {
    const calls: unknown[][] = [];
    const api: PhoneApi = { setCaps: async (...a) => void calls.push(a), rename: async () => undefined, revoke: async () => undefined };
    const phone = { ...PHONE, caps: ['watch', 'answer', 'type', 'control'] } as unknown as PairedDeviceInfo;
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [phone], phoneApi: api }));
    await click(q('.cx-namebtn'));
    expect(q<HTMLInputElement>('[data-testid="connect-phone-level-send"]')!.checked).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="connect-phone-more"]')!.checked).toBe(true);
    await click(q('[data-testid="connect-phone-level-watch"]'));
    await settle(4);
    expect(calls).toEqual([['p1', ['watch', 'control']]]);
    await click(q('[data-testid="connect-phone-level-answer"]'));
    await settle(4);
    expect(calls.at(-1)).toEqual(['p1', ['watch', 'answer', 'control']]);
    const radios = [...q('[data-testid="connect-phone-level"]')!.querySelectorAll('span')].map((s) => s.textContent);
    expect(radios).toEqual(['Watch only', 'Watch and answer', 'Watch, answer and send messages']);
  });

  it('a watch-only phone cannot be given the start-agents switch; lowering the level frees nothing', async () => {
    const phone = { ...PHONE, caps: ['watch'] } as unknown as PairedDeviceInfo;
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [phone] }));
    await click(q('.cx-namebtn'));
    expect(q<HTMLInputElement>('[data-testid="connect-phone-more"]')!.disabled).toBe(true);
    await click(q('[data-testid="connect-phone-level-answer"]'));
    await settle(4);
  });

  it('a watch-only phone shows Watch only checked', async () => {
    const phone = { ...PHONE, caps: ['watch'] } as unknown as PairedDeviceInfo;
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, phones: [phone] }));
    await click(q('.cx-namebtn'));
    expect(q<HTMLInputElement>('[data-testid="connect-phone-level-watch"]')!.checked).toBe(true);
    expect(q<HTMLInputElement>('[data-testid="connect-phone-more"]')!.checked).toBe(false);
  });
});
