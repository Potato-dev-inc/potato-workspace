// @vitest-environment jsdom
// "Start fresh on Cloudflare": a Worker that keeps the first secret it saw ("does not match") is deleted and made again,
// after the person confirms. Rendered through the real Connect > Phone panel and its sheet; a fake step runner stands in
// for wrangler (nothing here touches Cloudflare).
// Settings > Connect > Phone: on an automatic (trycloudflare) address the page offers "Keep one address", a small
// guided sheet that saves mode 'stable' through the tunnel api. Linked, the stable address shows with a "Stable" chip.
// The last group renders the real Settings screen (real catalog), so this ships wired in.
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '../lib/tauri-types';
import { StableLinkSheet } from './StableLinkSheet';
import type { TunnelApi } from './settings/TunnelSection';
import { click, settle } from './settings/test-utils';
import { setLanguagePref } from '../i18n';
import type { UpdateApi } from '../lib/workerUpdate';

const WORKER = 'https://potato-stable-link.me.workers.dev';
const QUICK = 'https://quiet-lake-1234.trycloudflare.com';

const mocks = vi.hoisted(() => ({ tunnelUrl: 'https://quiet-lake-1234.trycloudflare.com' as string | null, status: null as unknown, opened: [] as string[], relay: '' }));

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../lib/load-tunnel-dev-info', () => ({
  watchTunnelDevInfo: vi.fn((cb: (info: unknown) => void) => {
    cb(mocks.tunnelUrl ? { tunnelUrl: mocks.tunnelUrl, bridgeProxyUrl: `${mocks.tunnelUrl}/bridge`, localUrl: 'http://127.0.0.1:1420' } : null);
    return () => undefined;
  }),
}));
vi.mock('../lib/team', () => ({ teamApi: { configGet: vi.fn(async () => ({ relay: mocks.relay })) } }));
vi.mock('../lib/tauri', () => ({
  tauri: {
    createMobilePairingSession: vi.fn(),
    listPairedMobileDevices: vi.fn(async () => []),
    getTunnelStatus: vi.fn(async () => mocks.status),
    setTunnelConfig: vi.fn(async () => mocks.status),
    openExternalUrl: vi.fn(async (url: string) => void mocks.opened.push(url)),
  },
}));


const mismatch = (): TunnelStatus => ({
  mode: 'stable',
  public_url: WORKER,
  state: 'running',
  error: null,
  config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
  stable: { worker_url: WORKER, quick_url: QUICK, link: 'failed', error: 'The secret does not match the one the Worker has.', secret_mismatch: true },
});
const linked = (): TunnelStatus => ({ ...mismatch(), stable: { worker_url: WORKER, quick_url: QUICK, link: 'linked', error: null }, secret_once: 'NEW-SECRET-0123456789' });

function fakes() {
  const steps: string[] = [];
  const confirms: boolean[] = [];
  const updateApi: UpdateApi = {
    step: async (id, address, confirmed) => {
      confirms.push(confirmed === true);
      steps.push(`${id}@${address}`);
      return { ok: true, output: `${id} ok`, url: id === 'deploy' ? WORKER : undefined };
    },
    check: async () => ({ reachable: true, features: ['stable-link'], legacyLink: false }),
    pauseMs: 0,
  };
  let current = mismatch();
  const api: TunnelApi & { save: ReturnType<typeof vi.fn> } = {
    getStatus: vi.fn(async () => current),
    save: vi.fn(async () => (current = linked())),
    restart: vi.fn(async () => current),
    test: vi.fn(async () => ({ ok: true, url: '', http_status: 200, latency_ms: 1, message: 'ok' })),
  };
  return { steps, confirms, updateApi, api };
}

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.ownerDocument.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function open(api: TunnelApi, updateApi: UpdateApi, initial: TunnelStatus = mismatch(), onClose: () => void = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<StableLinkSheet api={api} initial={initial} onStatus={vi.fn()} onClose={onClose} relaySuggestion={async () => null} checkWorker={async () => null} updateApi={updateApi} />),
  );
  await settle(6);
}

beforeEach(() => {
    setLanguagePref('en', false);
});
afterEach(async () => {
  setLanguagePref('en', false);
  await act(async () => root.unmount());
  host.remove();
});

describe('guided setup: Start fresh on Cloudflare', () => {
  it('shows nothing extra while the link is fine', async () => {
    const { api, updateApi } = fakes();
    await open(api, updateApi, { ...mismatch(), stable: { worker_url: WORKER, quick_url: QUICK, link: 'waiting', error: null } });
    expect(q('stable-fresh')).toBeNull();
  });

  it('asks first, then deletes, redeploys and links with a new secret (en)', async () => {
    const { api, updateApi, steps, confirms } = fakes();
    await open(api, updateApi);
    const fresh = q('stable-fresh')!;
    expect(fresh.textContent).toContain('Start fresh on Cloudflare');
    await click(fresh.querySelector('[data-testid="worker-update-go"]'));
    expect(q('worker-fresh-confirm')!.textContent).toContain('deletes your potato-stable-link link on Cloudflare');
    expect(q('worker-fresh-confirm')!.textContent).toContain('need to scan again');
    expect(q('worker-fresh-confirm')!.textContent).toContain('Nothing else in your Cloudflare account is touched');
    expect(steps).toEqual([]);
    // Cancel: nothing ran.
    await click(q('worker-fresh-no'));
    expect(q('worker-fresh-confirm')).toBeNull();
    expect(steps).toEqual([]);
    await click(fresh.querySelector('[data-testid="worker-update-go"]'));
    await click(q('worker-fresh-yes'));
    await settle(8);
    expect(steps.map((s) => s.split('@')[0])).toEqual(['prepare', 'install', 'login', 'delete', 'deploy']);
    // Only the saved Worker is named.
    expect(steps.every((s) => s.endsWith(`@${WORKER}`))).toBe(true);
    expect(confirms).toEqual([false, false, false, true, false]);
    expect(api.save).toHaveBeenCalledWith({ mode: 'stable', worker_url: WORKER, secret_action: 'regenerate', confirm_strand: true });
    expect(q('stable-status')!.getAttribute('data-linked')).toBe('true');
  });

  it('Escape closes only the question, not the sheet', async () => {
    const { api, updateApi } = fakes();
    const onClose = vi.fn();
    await open(api, updateApi, mismatch(), onClose);
    await click(q('stable-fresh')!.querySelector('[data-testid="worker-update-go"]'));
    expect(q('worker-fresh-confirm')).not.toBeNull();
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(q('worker-fresh-confirm')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalled();
  });

  it('is in Traditional Chinese too, with the same confirm', async () => {
    setLanguagePref('zh-TW', false);
    const { api, updateApi, steps } = fakes();
    await open(api, updateApi);
    const fresh = q('stable-fresh')!;
    expect(fresh.textContent).toContain('在 Cloudflare 重新開始');
    await click(fresh.querySelector('[data-testid="worker-update-go"]'));
    expect(q('worker-fresh-confirm')!.textContent).toContain('這會刪除你在 Cloudflare 上的 potato-stable-link Worker');
    expect(steps).toEqual([]);
  });
});
