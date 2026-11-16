// @vitest-environment jsdom
// Settings > Connect > Phone: on an automatic (trycloudflare) address the page offers "Keep one address", a small
// guided sheet that saves mode 'stable' through the tunnel api. Linked, the stable address shows with a "Stable" chip.
// The last group renders the real Settings screen (real catalog), so this ships wired in.
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TunnelStatus } from '../lib/tauri-types';
import { MobilePairingPanel } from './MobilePairingPanel';
import { StableLinkSheet } from './StableLinkSheet';
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

  it('the sheet shows the steps and one "Set up stable link" button, and no command', async () => {
    await mount(fakeApi(quick));
    await click(q('keep-one-address'));
    const sheet = q('stable-sheet')!;
    expect(sheet.textContent).toContain('free Cloudflare link');
    expect(sheet.querySelector('.stable-cmd code')).toBeNull();
    expect(sheet.textContent).not.toMatch(/wrangler|npm |relay.worker/);
    expect(q('worker-update-go')!.textContent).toBe('Set up one fixed address');
    expect(q('stable-guide')).toBeNull();
    expect(q('stable-status')!.textContent).toContain('Not linked yet');
  });

  it('pasting the Worker address saves mode stable, shows the secret once and the linked state', async () => {
    const api = fakeApi(quick);
    await mount(api);
    await click(q('keep-one-address'));
    const input = q('stable-sheet')!.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
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
    expect(hint.textContent).toContain("Use https://team-relay.me.workers.dev (your team's link)");
    expect(hint.textContent).toContain('One link does both jobs');
    const input = q('stable-sheet')!.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
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
    await act(async () => root.render(<SettingsPanel open withConnect api={settingsApi} initialTab="connect" />));
    await settle(8);
    // Connect > Phone: "Pair a phone" opens the pairing panel, which carries "Keep one address".
    await click(host.querySelector('[data-testid="connect-main-phone"]'));
    await settle(30);
    const offer = host.querySelector<HTMLElement>('[data-testid="keep-one-address"]');
    expect(offer).not.toBeNull();
    await click(offer);
    expect(host.querySelector('[data-testid="stable-sheet"]')).not.toBeNull();
  });
});

describe('one Worker: the team relay address is offered for the phone link only when it can do it', () => {
  const sheet = async (health: { reachable: boolean; features: string[]; legacyLink?: boolean } | null) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <StableLinkSheet
          api={fakeApi(quick)}
          initial={quick}
          onStatus={() => undefined}
          onClose={() => undefined}
          relaySuggestion={async () => 'https://team-relay.me.workers.dev'}
          checkWorker={async () => (health ? { legacyLink: false, ...health } : null)}
        />,
      ),
    );
    await settle(4);
  };
  const find = (id: string) => host.querySelector(`[data-testid="${id}"]`);

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('a Worker that lists stable-link: "Use <address>" fills the field', async () => {
    await sheet({ reachable: true, features: ['team', 'rooms', 'stable-link', 'invites'] });
    const hint = find('stable-relay-suggestion')!;
    expect(hint.textContent).toContain("Use https://team-relay.me.workers.dev (your team's link)");
    await click(hint.querySelector('button'));
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!.value).toBe('https://team-relay.me.workers.dev');
  });

  it('an older team relay: "Update your Worker" with the one command, and no Use button', async () => {
    await sheet({ reachable: true, features: ['team'] });
    expect(find('stable-relay-suggestion')).toBeNull();
    const update = find('worker-update')!;
    expect(update.textContent).toContain('Update your link');
    expect(update.querySelector('[data-testid="worker-update-go"]')!.textContent).toBe('Update your link');
    expect(update.textContent).not.toMatch(/wrangler|npm run|relay.worker/);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!.value).toBe('');
  });

  it('a relay that does not answer is not offered', async () => {
    await sheet({ reachable: false, features: [] });
    expect(find('stable-relay-suggestion')).toBeNull();
    expect(find('worker-unreachable')).not.toBeNull();
  });

  describe('the buttons that run the steps', () => {
    const GOOD = { reachable: true, features: ['team', 'rooms', 'stable-link', 'invites'], legacyLink: false };
    const stepsApi = (failStep?: string, url?: string) => {
      const calls: string[] = [];
      return {
        calls,
        pauseMs: 0,
        step: async (id: string) => {
          calls.push(id);
          return id === failStep ? { ok: false, output: 'Error: no network' } : { ok: true, output: '', url: id === 'deploy' ? url : undefined };
        },
        check: async () => GOOD,
      };
    };
    const open = async (opts: { relay: string | null; health: () => { reachable: boolean; features: string[]; legacyLink: boolean }; update: ReturnType<typeof stepsApi> }) => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () =>
        root.render(
          <StableLinkSheet
            api={fakeApi(quick)}
            initial={quick}
            onStatus={() => undefined}
            onClose={() => undefined}
            relaySuggestion={async () => opts.relay}
            checkWorker={async () => opts.health()}
            updateApi={opts.update as never}
          />,
        ),
      );
      await settle(4);
    };
    const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Link address"]')!;
    const go = () => host.querySelector<HTMLElement>('[data-testid="worker-update-button"] [data-testid="worker-update-go"]');

    it('"Set up stable link" runs every step and puts the new address in the box', async () => {
      const update = stepsApi(undefined, 'https://potato-stable-link.me.workers.dev');
      await open({ relay: null, health: () => GOOD, update });
      expect(go()!.textContent).toBe('Set up one fixed address');
      expect(host.textContent).not.toContain('is filled in for you');
      await click(go());
      await settle(10);
      expect(update.calls).toEqual(['prepare', 'install', 'login', 'deploy']);
      expect(host.querySelectorAll('[data-step][data-status="done"]')).toHaveLength(5);
      expect(field().value).toBe('https://potato-stable-link.me.workers.dev');
      expect(host.textContent).toContain('is filled in for you');
    });

    it('a failed deploy never says the address is filled in', async () => {
      const update = stepsApi('install');
      await open({ relay: null, health: () => GOOD, update });
      await click(go());
      await settle(10);
      expect(field().value).toBe('');
      expect(host.textContent).not.toContain('is filled in for you');
    });

    it('an old Worker: "Update Worker" finishes, the notice goes away and the address can be used', async () => {
      let updated = false;
      const update = stepsApi();
      const send = update.step;
      update.step = async (id: string) => {
        if (id === 'deploy') updated = true;
        return send(id);
      };
      await open({ relay: 'https://team-relay.me.workers.dev', health: () => (updated ? GOOD : { reachable: true, features: ['team'], legacyLink: false }), update });
      expect(find('worker-update')).not.toBeNull();
      await click(host.querySelector('[data-testid="worker-update"] [data-testid="worker-update-go"]'));
      await settle(10);
      expect(find('worker-update')).toBeNull();
      expect(find('stable-relay-suggestion')).not.toBeNull();
    });

    it('three failures: one plain sentence and a way out (the note to copy when no agent can chat), and no command shown', async () => {
      const update = stepsApi('install');
      await open({ relay: 'https://team-relay.me.workers.dev', health: () => ({ reachable: true, features: ['team'], legacyLink: false }), update });
      await click(host.querySelector('[data-testid="worker-update"] [data-testid="worker-update-go"]'));
      await settle(14);
      expect(update.calls.filter((c) => c === 'install')).toHaveLength(3);
      expect(find('worker-update-failed')!.textContent).toContain('Installing the tool it needs did not work.');
      expect(find('worker-update-failed')!.textContent).toContain('Tried 3 times');
      // Nothing is handed over until the person asks; the raw error stays behind Details.
      expect(find('worker-update-copy-note')).toBeNull();
      await click(host.querySelector('[data-testid="worker-update-fix"]'));
      await settle(4);
      expect(find('worker-update-copy-note')).not.toBeNull();
      expect(host.textContent).not.toMatch(/wrangler|npm run|relay.worker/);
    });
  });

});
