// Shared helpers for the Connect screen tests (no testing-library in this repo: act + createRoot). Only the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import type { PairedDeviceInfo, Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { AccountApi, AccountPcsReply } from '../../lib/account';
import type { TeamApi } from '../../lib/team';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';
import { BASE_SETTINGS, settle } from '../settings/test-utils';
import { ConnectPage, type ConnectApi } from './ConnectPage';
import type { ConnectTab } from '../../lib/openConnect';
import type { PhoneApi } from './PhoneGroup';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

export const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
export const text = (sel: string) => q(sel)?.textContent ?? '';

export const WORKER = 'https://pm-relay.maya.workers.dev';
export const stable = (link: 'linked' | 'linking' | 'waiting' | 'failed', over: Partial<TunnelStatus> = {}): TunnelStatus =>
  ({
    mode: 'stable',
    public_url: WORKER,
    state: 'running',
    error: null,
    config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
    stable: { worker_url: WORKER, quick_url: 'https://quick-one.trycloudflare.com', link, error: link === 'failed' ? 'The link was refused.' : null },
    ...over,
  }) as TunnelStatus;
export const quick = (over: Partial<TunnelStatus> = {}): TunnelStatus =>
  ({ mode: 'quick', public_url: 'https://quick-one.trycloudflare.com', state: 'running', error: null, config: { mode: 'quick', hostname: null, url: null, has_token: false }, ...over }) as TunnelStatus;

export const PHONE = { id: 'p1', name: "Ren's iPhone", created_at: 1, last_seen: 1, expired: false, caps: ['watch', 'answer', 'type'] } as unknown as PairedDeviceInfo;

export function fakeTunnel(first: TunnelStatus, onRestart?: (n: number) => TunnelStatus, extra: Partial<TunnelApi> = {}) {
  let current = first;
  const calls = { restart: 0, test: 0 };
  const api: TunnelApi = {
    getStatus: async () => current,
    save: async () => current,
    restart: async () => {
      calls.restart += 1;
      current = onRestart ? onRestart(calls.restart) : stable('linked');
      return current;
    },
    test: async () => {
      calls.test += 1;
      return { ok: true, url: WORKER, http_status: 200, latency_ms: 4, message: 'ok' };
    },
    ...extra,
  };
  return { api, calls };
}

export function fakeTeam(active: boolean, configOver: Record<string, unknown> = {}): TeamApi {
  return {
    state: async () => teamState({ active, presence: [] }),
    configGet: async () => teamConfig(active ? { ...configOver } : { team: '', ...configOver }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
}

export function fakeAccount(reply: Partial<AccountPcsReply> | null): AccountApi {
  const state = { configured: true, signed_in: reply !== null, waiting: false, message: null, account: null, device_id: null };
  return {
    state: async () => state,
    signIn: async () => state,
    cancel: async () => state,
    devices: async () => ({ signed_in: reply !== null, devices: [] }),
    revoke: async () => ({ signed_in: true, devices: [] }),
    signOutHere: async () => state,
    pcs: async () => ({ available: true, signed_in: reply !== null, open_here: false, published: false, pcs: [], ...reply }),
    openPc: async (id: string) => ({ paired: true, node: id, name: id, state: 'online' }),
    setOpenHere: async () => undefined,
    dismissRemoved: async () => undefined,
    onChanged: async () => () => {},
  } as unknown as AccountApi;
}

export interface MakeApi {
  settings?: Partial<Settings>;
  phones?: PairedDeviceInfo[];
  devices?: DevicesFake;
  tunnel?: TunnelApi;
  team?: TeamApi;
  lend?: ReturnType<typeof createFakeLendApi>;
  account?: AccountApi;
  phoneApi?: PhoneApi;
  workerHealth?: ConnectApi['workerHealth'];
}
export function makeApi(over: MakeApi = {}): Partial<ConnectApi> & { patches: unknown[] } {
  const patches: unknown[] = [];
  let settings = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true, far_pcs_enabled: false, ...(over.account ? { account_enabled: true } : {}), ...over.settings } as Settings;
  return {
    patches,
    loadSettings: async () => settings,
    patchSettings: async (p) => {
      patches.push(p);
      settings = { ...settings, ...(p as object) } as Settings;
      return settings;
    },
    listPhones: async () => over.phones ?? [],
    devices: over.devices ?? new DevicesFake({ enabled: true, name: 'REN-DESK' }),
    team: over.team ?? fakeTeam(false, { joins: [] }),
    lend: over.lend ?? createFakeLendApi(lendState({ grants: [] })),
    tunnel: over.tunnel ?? fakeTunnel(quick()).api,
    account: over.account ?? fakeAccount(null),
    ...(over.phoneApi ? { phoneApi: over.phoneApi } : {}),
    ...(over.workerHealth ? { workerHealth: over.workerHealth } : {}),
  };
}

export interface Harness {
  mount: (api: Partial<ConnectApi>, tab?: ConnectTab, extra?: { onOpenPc?: (node: string) => void }) => Promise<void>;
  remount: (api: Partial<ConnectApi>, tab?: ConnectTab) => Promise<void>;
  unmount: () => Promise<void>;
}
/** Mount helpers bound to a fresh host element (call in beforeEach, `unmount` in afterEach). */
export function harness(): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root = createRoot(host);
  const render = async (api: Partial<ConnectApi>, tab: ConnectTab, extra?: { onOpenPc?: (node: string) => void }) => {
    await act(async () => root.render(<ConnectPage tab={tab} onTab={() => undefined} api={api} onOpenPc={extra?.onOpenPc} />));
    await settle(10);
  };
  return {
    mount: (api, tab = 'devices', extra) => render(api, tab, extra),
    remount: async (api, tab = 'devices') => {
      await act(async () => root.unmount());
      root = createRoot(host);
      await render(api, tab);
    },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
      document.body.innerHTML = '';
      vi.restoreAllMocks();
    },
  };
}
