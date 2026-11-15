// @vitest-environment jsdom
// Settings > Connect > Phone: on an automatic (trycloudflare) address the page offers "Keep one address", a small
// guided sheet that saves mode 'stable' through the tunnel api. Linked, the stable address shows with a "Stable" chip.
// The last group renders the real Settings screen (real catalog), so this ships wired in.
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '../lib/tauri-types';
import { MobilePairingPanel } from './MobilePairingPanel';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';
import type { TunnelApi } from './settings/TunnelSection';
import { BASE_SETTINGS, click, settle, type as typeInto } from './settings/test-utils';

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

const quick: TunnelStatus = {
  mode: 'quick',
  public_url: QUICK,
  state: 'running',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
};
const stable = (link: 'linked' | 'failed' | 'waiting', extra: Partial<TunnelStatus> = {}): TunnelStatus => ({
  mode: 'stable',
  public_url: WORKER,
  state: 'running',
  error: null,
  config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
  stable: { worker_url: WORKER, quick_url: QUICK, link, error: link === 'failed' ? 'The secret does not match.' : null },
  ...extra,
});

function fakeApi(initial: TunnelStatus): TunnelApi & { save: ReturnType<typeof vi.fn> } {
  let current = initial;
  return {
    getStatus: vi.fn(async () => current),
    save: vi.fn(async (input) => {
      if (input.mode === 'stable') current = stable('linked', input.secret_action === 'show' ? { secret_once: 'SECRET-ONCE-0123456789' } : { secret_once: 'SECRET-ONCE-0123456789' });
      return current;
    }),
    restart: vi.fn(async () => current),
    test: vi.fn(async () => ({ ok: true, url: '', http_status: 200, latency_ms: 1, message: 'ok' })),
  };
}

let host: HTMLDivElement;
let root: Root;
type Props = ComponentProps<typeof MobilePairingPanel>;

async function mount(tunnelApi: TunnelApi, overrides: Partial<Props> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<MobilePairingPanel publicPwaUrl="" devServerPort={1420} onPublicPwaUrlChange={vi.fn()} onDevServerPortChange={vi.fn()} tunnelApi={tunnelApi} {...overrides} />),
  );
  await settle(6);
}
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  mocks.tunnelUrl = QUICK;
  mocks.opened = [];
  mocks.relay = '';
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Connect > Phone: keep one address', () => {
  it('offers "Keep one address" on an automatic trycloudflare address', async () => {
    await mount(fakeApi(quick));
    expect(q('pairing-origin')!.textContent).toContain('quiet-lake-1234.trycloudflare.com');
    expect(q('stable-offer')!.textContent).toContain('changes every time the app restarts');
    expect(q('keep-one-address')!.textContent).toBe('Keep one address');
    expect(q('stable-chip')).toBeNull();
  });

  it('does not offer it on an address of your own', async () => {
    mocks.tunnelUrl = 'https://pm.example.com';
    await mount(fakeApi({ ...quick, public_url: 'https://pm.example.com' }));
    expect(q('keep-one-address')).toBeNull();
  });

  it('does not offer it in the first-run welcome', async () => {
    await mount(fakeApi(quick), { compact: true });
    expect(q('keep-one-address')).toBeNull();
  });

  it('the sheet shows the steps, copy buttons for three commands, and the guide link', async () => {
    await mount(fakeApi(quick));
    await click(q('keep-one-address'));
    const sheet = q('stable-sheet')!;
    expect(sheet.textContent).toContain('free Cloudflare Worker');
    const commands = [...sheet.querySelectorAll('.stable-cmd code')].map((c) => c.textContent);
    expect(commands).toEqual(['cd relay/stable-link && npm install', 'npx wrangler login', 'npm run deploy']);
    await click(sheet.querySelector('.stable-cmd button'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('cd relay/stable-link && npm install');
    await click(q('stable-guide'));
    expect(mocks.opened[0]).toContain('relay/stable-link');
    expect(q('stable-status')!.textContent).toContain('Not linked yet');
  });

  it('pasting the Worker address saves mode stable, shows the secret once and the linked state', async () => {
    const api = fakeApi(quick);
    await mount(api);
    await click(q('keep-one-address'));
    const input = q('stable-sheet')!.querySelector<HTMLInputElement>('input[aria-label="Worker address"]')!;
    expect(q('stable-link')!.hasAttribute('disabled')).toBe(true);
    await typeInto(input, WORKER);
    await click(q('stable-link'));
    await settle(4);
    expect(api.save).toHaveBeenCalledWith({ mode: 'stable', worker_url: WORKER, secret: null, secret_action: 'keep' });
    expect(q('stable-sheet')!.textContent).toContain('SECRET-ONCE-0123456789');
    expect(q('stable-status')!.getAttribute('data-linked')).toBe('true');
    expect(q('stable-status')!.textContent).toContain('Linked ✓');
    // Behind the sheet the page now shows the stable address with a chip, and the automatic one only as "behind it".
    expect(q('pairing-origin')!.textContent).toContain('potato-stable-link.me.workers.dev');
    expect(q('stable-chip')!.textContent).toBe('Stable');
    expect(q('pairing-behind')!.textContent).toContain('quiet-lake-1234.trycloudflare.com');
    expect(q('keep-one-address')).toBeNull();
  });

  it('when linked it shows the stable address with a chip and keeps the mode picker', async () => {
    const api = fakeApi(stable('linked'));
    await mount(api);
    expect(q('stable-chip')).not.toBeNull();
    // Linked: no offer; the fold still has the mode picker so nothing is hidden.
    expect(q('keep-one-address')).toBeNull();
    expect(host.querySelector('[data-testid="pairing-tunnel-modes"] select[aria-label]')).not.toBeNull();
  });

  it('suggests a saved team relay address in the Worker field, only as a pre-fill with a note', async () => {
    mocks.relay = 'https://team-relay.me.workers.dev/';
    await mount(fakeApi(quick));
    await click(q('keep-one-address'));
    await settle(3);
    const hint = q('stable-relay-suggestion')!;
    expect(hint.textContent).toContain('Use https://team-relay.me.workers.dev (your team relay)');
    expect(hint.textContent).toContain('must also include the stable-link part');
    const input = q('stable-sheet')!.querySelector<HTMLInputElement>('input[aria-label="Worker address"]')!;
    expect(input.value).toBe('');
    await click(hint.querySelector('button'));
    expect(input.value).toBe('https://team-relay.me.workers.dev');
  });

  it('draws no suggestion for a relay that is not a workers.dev address', async () => {
    mocks.relay = 'https://relay.acme.dev';
    await mount(fakeApi(quick));
    await click(q('keep-one-address'));
    await settle(3);
    expect(q('stable-relay-suggestion')).toBeNull();
  });

  it('a Worker that is not linked says why and offers the steps again', async () => {
    mocks.tunnelUrl = WORKER;
    await mount(fakeApi(stable('failed')));
    expect(q('stable-chip')).toBeNull();
    expect(q('stable-pending')).not.toBeNull();
    await click(q('stable-fix'));
    expect(q('stable-status')!.textContent).toContain('Not linked yet');
    expect(q('stable-status')!.textContent).toContain('The secret does not match.');
  });

  it('"Address (advanced)" holds the same mode picker as the tunnel section, with the stable choice', async () => {
    await mount(fakeApi(quick));
    const select = host.querySelector<HTMLSelectElement>('[data-testid="pairing-address"] select')!;
    expect([...select.options].map((o) => o.value)).toEqual(['quick', 'named', 'custom', 'stable']);
    expect(q('pairing-address')!.textContent).toContain('Phone page address');
  });
});

describe('Settings screen (real catalog): Connect page', () => {
  const settingsApi: SettingsApi = {
    load: async () => ({ ...BASE_SETTINGS }),
    patch: async () => ({ ...BASE_SETTINGS }),
    findBridgeUrl: async () => null,
    subscribe: () => () => {},
  };

  it('shows the phone address with "Keep one address" on the Connect page, and the sheet opens', async () => {
    mocks.status = quick;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<SettingsPanel open api={settingsApi} initialTab="connect" />));
    await settle(8);
    // The Phone card starts closed on the Connect page: open it.
    await click(host.querySelector('.st-closed-group[data-group="Phone"] .st-adv-toggle'));
    await settle(8);
    const offer = host.querySelector<HTMLElement>('[data-testid="keep-one-address"]');
    expect(offer).not.toBeNull();
    await click(offer);
    expect(host.querySelector('[data-testid="stable-sheet"]')).not.toBeNull();
  });
});
