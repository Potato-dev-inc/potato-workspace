// @vitest-environment jsdom
// Connect > "Your relay": the one Worker the phone and the team share, in one place, on every tab. Through the real page.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { DevicesFake } from '../../dev/devices-fixtures';
import { createFakeLendApi, lendState } from '../../dev/lend-fixtures';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import { setLanguagePref } from '../../i18n';
import { tauri } from '../../lib/tauri';
import type { TeamApi } from '../../lib/team';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { TunnelApi } from '../settings/TunnelSection';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';
import { resetRememberedTab } from '../team-page/TeamPage';
import { ConnectPage, type ConnectApi } from './ConnectPage';
import type { ConnectTab } from '../../lib/openConnect';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
vi.mock('../settings/TunnelSection', () => ({ TunnelSection: () => <div data-testid="tunnel-stub" /> }));

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
  setLanguagePref('en', false);
  resetRememberedTab();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  setLanguagePref('en', false);
});

const WORKER = 'https://pm-relay.maya.workers.dev';
const stable = (link: 'linked' | 'waiting'): TunnelStatus =>
  ({ mode: 'stable', public_url: null, state: 'running', error: null, config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true }, stable: { worker_url: WORKER, quick_url: null, link, error: null } }) as TunnelStatus;
const quick: TunnelStatus = { mode: 'quick', public_url: null, state: 'running', error: null, config: { mode: 'quick', hostname: null, url: null, has_token: false } } as TunnelStatus;

function api(tunnelStatus: TunnelStatus | null, teamRelay: string): Partial<ConnectApi> {
  const tunnel: TunnelApi = {
    getStatus: async () => tunnelStatus,
    save: async () => tunnelStatus!,
    restart: async () => tunnelStatus!,
    test: async () => ({ ok: true, url: WORKER, http_status: 200, latency_ms: 4, message: 'ok' }),
  };
  const team = {
    state: async () => teamState({ active: false, presence: [] }),
    configGet: async () => teamConfig({ team: '', relay: teamRelay }),
    defaultName: async () => 'Leo',
    onChanged: async () => () => {},
    onDraft: async () => () => {},
  } as unknown as TeamApi;
  const settings = { ...BASE_SETTINGS, lend_enabled: true, devices_enabled: true } as Settings;
  return {
    loadSettings: async () => settings,
    patchSettings: async () => settings,
    listPhones: async () => [],
    devices: new DevicesFake({ enabled: true }),
    team,
    lend: createFakeLendApi(lendState({ grants: [] })),
    tunnel,
  };
}

async function mount(a: Partial<ConnectApi>, tab: ConnectTab = 'phone') {
  await act(async () => root.render(<ConnectPage tab={tab} onTab={() => undefined} api={a} />));
  await settle(8);
}
const q = (sel: string) => document.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

describe('Connect > Your relay', () => {
  it('shows the one relay with its status and that Phone and Team share it', async () => {
    await mount(api(stable('linked'), WORKER));
    expect(text('[data-testid="connect-relay-host"]')).toBe('pm-relay.maya.workers.dev');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Ready');
    expect(text('[data-testid="connect-relay-used"]')).toBe('Used by: Phone, Team');
    expect(text('[data-testid="connect-relay"]')).not.toMatch(/secret|token/i);
  });

  it('is the same row on every tab', async () => {
    await mount(api(stable('waiting'), ''), 'team');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Not linked yet');
    expect(text('[data-testid="connect-relay-used"]')).toBe('Used by: Phone');
    expect(document.querySelectorAll('[data-testid="connect-relay"]')).toHaveLength(1);
  });

  it('no relay yet: says to set it up once (a quick address is not a relay)', async () => {
    await mount(api(quick, ''));
    expect(q('[data-testid="connect-relay"]')!.getAttribute('data-state')).toBe('none');
    expect(text('[data-testid="connect-relay-none"]')).toContain('Set it up once');
    expect(q('[data-testid="connect-relay-host"]')).toBeNull();
  });

  it('Team > Start a team, with a relay here, offers Use my relay', async () => {
    vi.spyOn(tauri, 'getTunnelStatus').mockResolvedValue(stable('linked'));
    await mount(api(stable('linked'), ''), 'team');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Start a team'));
    await settle(5);
    expect(q('[data-testid="relay-use"]')).not.toBeNull();
  });

  it('speaks Traditional Chinese', async () => {
    setLanguagePref('zh-TW', false);
    await mount(api(stable('linked'), WORKER));
    expect(text('[data-testid="connect-relay"]')).toContain('你的中繼站');
    expect(text('[data-testid="connect-relay-status"]')).toBe('已就緒');
    expect(text('[data-testid="connect-relay-used"]')).toBe('使用中：手機、團隊');
  });
});
