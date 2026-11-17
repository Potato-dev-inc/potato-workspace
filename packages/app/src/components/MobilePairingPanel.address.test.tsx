// @vitest-environment jsdom
// The phone address, end to end through the real pairing panel: the QR code and the line above it say the same thing.
// Root cause of "the QR still uses the old trycloudflare address / the phone says my PC is offline": the panel read the tunnel
// address once and kept it, and handed out a fixed (Worker) address before this PC was linked to it. Now the stable link
// decides, and while it is not linked no code is made. Only the desktop shell (tauri) and the QR canvas are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tauri } from '../lib/tauri';
import type { TunnelStatus } from '../lib/tauri-types';
import { MobilePairingPanel } from './MobilePairingPanel';
import type { TunnelApi } from './settings/TunnelSection';
import { click, settle } from './settings/test-utils';

const WORKER = 'https://pm-relay.me.workers.dev';
const QUICK = 'https://stale-old-quick.trycloudflare.com';

const mocks = vi.hoisted(() => ({
  session: { pairing_code: 'ABCD1234', expires_at: 4102444800, server_public_key: 'pk', bridge_url: '', qr_payload: { v: 1, u: 'https://x/bridge', pk: 'pk', c: 'ABCD1234', e: 4102444800 } },
}));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
// The first read of the tunnel address is the OLD automatic one, and it is never refreshed here: the stable status must win.
vi.mock('../lib/load-tunnel-dev-info', () => ({
  watchTunnelDevInfo: vi.fn((cb: (info: unknown) => void) => {
    cb({ tunnelUrl: 'https://stale-old-quick.trycloudflare.com', bridgeProxyUrl: 'https://stale-old-quick.trycloudflare.com/bridge', localUrl: 'http://127.0.0.1:1420' });
    return () => undefined;
  }),
}));
vi.mock('../lib/team', () => ({ teamApi: { configGet: vi.fn(async () => ({ relay: '' })) } }));
vi.mock('../lib/tauri', () => ({
  tauri: {
    createMobilePairingSession: vi.fn(async () => mocks.session),
    listPairedMobileDevices: vi.fn(async () => []),
  },
}));

const quick: TunnelStatus = { mode: 'quick', public_url: QUICK, state: 'running', error: null, config: { mode: 'quick', hostname: null, url: null, has_token: false } };
const stable = (link: 'linked' | 'failed' | 'waiting' | 'linking', error: string | null = null): TunnelStatus => ({
  mode: 'stable',
  public_url: WORKER,
  state: 'running',
  error: null,
  config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
  stable: { worker_url: WORKER, quick_url: QUICK, link, error },
});

let host: HTMLDivElement;
let root: Root;
let current: TunnelStatus;
const api = (): TunnelApi => ({
  getStatus: async () => current,
  save: async () => current,
  restart: async () => current,
  test: async () => ({ ok: true, url: '', http_status: 200, latency_ms: 1, message: 'ok' }),
});
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount(status: TunnelStatus, customUrl = '') {
  current = status;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<MobilePairingPanel publicPwaUrl={customUrl} devServerPort={1420} onPublicPwaUrlChange={vi.fn()} onDevServerPortChange={vi.fn()} tunnelApi={api()} />));
  await settle(6);
}
const lastQrText = () => String(vi.mocked(QRCode.toCanvas).mock.calls.at(-1)?.[1]);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Phone: the address in the QR code', () => {
  it('a linked Worker is what the QR code and the code request use, even when the first address read was the old automatic one', async () => {
    await mount(stable('linked'));
    expect(q('pairing-origin')!.textContent).toContain('pm-relay.me.workers.dev');
    await click(q('pair-a-phone'));
    await settle(4);
    expect(tauri.createMobilePairingSession).toHaveBeenCalledWith(`${WORKER}/bridge`, expect.anything());
    expect(lastQrText()).toBe(`${WORKER}/pair/ABCD1234`);
    expect(lastQrText()).not.toContain('trycloudflare');
  });

  it('with the automatic address, the QR code uses it (nothing else is known)', async () => {
    await mount(quick);
    await click(q('pair-a-phone'));
    await settle(4);
    expect(lastQrText()).toBe(`${QUICK}/pair/ABCD1234`);
  });

  it('a Worker this PC is not linked to makes no code: the reason shows and the button is off', async () => {
    await mount(stable('failed', 'The secret does not match the one the Worker has. Make a new secret, or reset the Worker.'));
    expect(q('pairing-not-ready-why')!.textContent).toContain('The secret does not match');
    expect(q('pairing-origin')).toBeNull();
    expect(q('pair-a-phone')!.hasAttribute('disabled')).toBe(true);
    expect(host.textContent).toContain('A code is made as soon as your fixed address is ready.');
    await click(q('pair-a-phone'));
    await settle(3);
    expect(tauri.createMobilePairingSession).not.toHaveBeenCalled();
    expect(vi.mocked(QRCode.toCanvas)).not.toHaveBeenCalled();
  });

  it('still linking says it takes a few seconds, then the button turns on by itself', async () => {
    vi.useFakeTimers();
    await mount(stable('linking'));
    expect(q('pairing-not-ready-why')!.textContent).toContain('few seconds');
    expect(q('pair-a-phone')!.hasAttribute('disabled')).toBe(true);
    current = stable('linked');
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(q('pairing-not-ready')).toBeNull();
    expect(q('pair-a-phone')!.hasAttribute('disabled')).toBe(false);
  });

  it('a code made on the automatic address is dropped when the person switches to the Worker', async () => {
    vi.useFakeTimers();
    await mount(quick);
    await click(q('pair-a-phone'));
    await settle(4);
    expect(q('pairing-code')).not.toBeNull();
    current = stable('linked');
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(q('pairing-code')).toBeNull();
    expect(q('pair-a-phone')).not.toBeNull();
  });

  it('a code is dropped when the Worker stops being linked, so a phone never scans a dead link', async () => {
    vi.useFakeTimers();
    await mount(stable('linked'));
    await click(q('pair-a-phone'));
    await settle(4);
    expect(q('pairing-code')).not.toBeNull();
    current = stable('failed', 'The Worker did not answer.');
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(q('pairing-code')).toBeNull();
    expect(q('pairing-not-ready-why')!.textContent).toBe('The Worker did not answer.');
  });

  it('an address typed on purpose still wins over the automatic one', async () => {
    await mount(quick, 'https://pm.example.com');
    await click(q('pair-a-phone'));
    await settle(4);
    expect(lastQrText()).toBe('https://pm.example.com/pair/ABCD1234');
  });

  it('draws no second Public address card inside the pairing panel', async () => {
    await mount(stable('linked'));
    expect(host.querySelectorAll('section[aria-label="Public address"]')).toHaveLength(0);
  });
});
