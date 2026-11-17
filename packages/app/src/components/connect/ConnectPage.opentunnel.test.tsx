// @vitest-environment jsdom
// The fixed phone address (OpenTunnel, Labs) through the real Connect page and the real TunnelSection: the option is
// hidden until the Labs switch is on, it carries the "third-party relay, may change" wording, choosing it saves
// `open_tunnel` with nothing secret, and "Forget this address" asks the app to delete it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import type { TunnelConfigInput, TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';
import { ConnectPage, type ConnectApi } from './ConnectPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

const QUICK: TunnelStatus = {
  mode: 'quick',
  public_url: 'https://abc.trycloudflare.com',
  state: 'running',
  error: null,
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
};
const FIXED: TunnelStatus = {
  mode: 'open_tunnel',
  public_url: 'https://k3x9q2.abc123.opentunnel.example',
  state: 'running',
  error: null,
  config: { mode: 'open_tunnel', hostname: null, url: null, has_token: false },
};

function fakeTunnel(first: TunnelStatus) {
  const saved: TunnelConfigInput[] = [];
  let forgotten = 0;
  let current = first;
  const api: TunnelApi = {
    getStatus: async () => current,
    save: async (input) => {
      saved.push(input);
      current = input.mode === 'open_tunnel' ? FIXED : QUICK;
      return current;
    },
    restart: async () => current,
    test: async () => ({ ok: true, url: current.public_url ?? '', http_status: 200, latency_ms: 5, message: 'ok' }),
    forget: async () => {
      forgotten += 1;
      current = QUICK;
      return current;
    },
  };
  return { api, saved, forgotten: () => forgotten };
}

function connectApi(settings: Partial<Settings>, tunnel: TunnelApi): Partial<ConnectApi> {
  const state = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true, ...settings } as Settings;
  return {
    loadSettings: async () => state,
    patchSettings: async () => state,
    listPhones: async () => [],
    devices: new DevicesFake({ enabled: true }),
    lend: createFakeLendApi(lendState({ grants: [] })),
    tunnel,
  };
}

async function open(api: Partial<ConnectApi>) {
  await act(async () => root.render(<ConnectPage tab="phone" onTab={() => undefined} api={api} />));
  await settle(8);
  await click(q('[data-testid="connect-address"]'));
  await settle(12);
}

const options = () => [...document.querySelectorAll<HTMLOptionElement>('select[aria-label="Tunnel mode"] option')].map((o) => o.value);

describe('Connect page: fixed phone address (OpenTunnel)', () => {
  it('is not offered while the Labs switch is off', async () => {
    const t = fakeTunnel(QUICK);
    await open(connectApi({ opentunnel_stable_link: false }, t.api));
    // The Public address card loads lazily: wait for its select instead of counting on a fixed number of settles.
    // (real time: the lazy chunk is a dynamic import, which a microtask flush does not wait for)
    for (let i = 0; i < 100 && options().length === 0; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
    expect(options()).toEqual(['quick', 'named', 'custom', 'stable']);
    expect(document.body.textContent).not.toContain('OpenTunnel');
  });

  it('is offered with the third-party warning once the switch is on, and choosing it saves open_tunnel and nothing else', async () => {
    const t = fakeTunnel(QUICK);
    await open(connectApi({ opentunnel_stable_link: true }, t.api));
    expect(options()).toContain('open_tunnel');
    const select = q<HTMLSelectElement>('select[aria-label="Tunnel mode"]')!;
    const label = [...select.options].find((o) => o.value === 'open_tunnel')!.textContent;
    expect(label).toBe('Fixed phone address (OpenTunnel, third-party relay, may change)');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'open_tunnel');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(4);
    const note = q('[data-testid="opentunnel-note"]')!;
    expect(note.textContent).toContain('someone else');
    expect(note.textContent).toContain('may change or stop');
    // Not saved yet, so nothing to forget yet.
    expect(q('[data-testid="opentunnel-forget"]')).toBeNull();
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save and restart')!;
    await click(save);
    await settle(6);
    expect(t.saved).toEqual([{ mode: 'open_tunnel' }]);
    expect(q('[data-testid="tunnel-url"]')!.textContent).toBe(FIXED.public_url);
  });

  it('Forget this address asks the app to delete it and falls back to the automatic address', async () => {
    const t = fakeTunnel(FIXED);
    // Even with the switch off, a saved fixed address stays visible so it can be forgotten.
    await open(connectApi({ opentunnel_stable_link: false }, t.api));
    expect(options()).toContain('open_tunnel');
    const forget = q<HTMLButtonElement>('[data-testid="opentunnel-forget"]')!;
    expect(forget.textContent).toBe('Forget this address');
    await click(forget);
    await settle(6);
    expect(t.forgotten()).toBe(1);
    expect(q('[data-testid="tunnel-url"]')!.textContent).toBe(QUICK.public_url);
    expect(q('[data-testid="opentunnel-forget"]')).toBeNull();
  });

  it('never shows a secret: the screen has no token field for this mode', async () => {
    const t = fakeTunnel(FIXED);
    await open(connectApi({ opentunnel_stable_link: true }, t.api));
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    // The address card itself has no token field for this mode (the Advanced glossary explains the word, so it is left out).
    expect(q('[data-testid="connect-tunnel"]')!.textContent).not.toMatch(/token/i);
  });
});
