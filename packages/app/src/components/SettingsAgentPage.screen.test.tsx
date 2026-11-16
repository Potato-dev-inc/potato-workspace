// @vitest-environment jsdom
// Slice 10: the per-agent rows (default model, chat or terminal, chat add-on, version, keep ready) live on the agent's own
// page. Rendered through the real Settings panel: the Agents page no longer lists them, opening Claude shows all five.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import type { AgentCaps, Cap } from '../lib/agentCaps';
import type { AgentRegistryListing } from '../lib/agentRegistry';
import { DEFAULT_STANDBY_CONFIG } from '../lib/standby';
import type { StandbyConfig, StandbyStatus } from '../lib/tauri-types';
import { setOpenAgent } from './settings/agents/agentTarget';
import { BASE_SETTINGS, click, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

const mocks = vi.hoisted(() => ({
  standby: { current: null as unknown as StandbyConfig },
  setConfig: vi.fn(),
}));

const cap = (value: Cap['value'] = 'unknown'): Cap => ({ value, source: value === 'unknown' ? 'unknown' : 'handshake', proof: value === 'unknown' ? '' : 'a fact', at: value === 'unknown' ? null : '2026-11-13T01:00:00Z' });
const claudeCaps = (): AgentCaps =>
  ({
    schema: 1, agent_id: 'claude', label: 'Claude', level: 'l0', level_proof: cap('yes'), program_version: '2.1.0', chat: cap('yes'), resume: cap(), shows_steps: cap(), edits_files: cap(),
    asks_before_edit: cap(), asks_before_shell: cap(), model_pick: cap('yes'), models: [], models_total: 0, stop: cap(), images: cap(), usage: cap(), read_only: cap(),
  }) as AgentCaps;

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('../lib/agentCaps', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentCaps')>();
  return { ...real, agentCapsApi: { get: async () => claudeCaps(), list: async () => [claudeCaps()], onChanged: () => () => undefined } };
});
vi.mock('../lib/agent-health', () => ({
  agentHealthApi: { check: async () => [{ id: 'claude', label: 'Claude', state: 'ready', installed: true, version: '2.1.0', reason: '', install_hint: null, login_hint: null, can_test: true }], test: vi.fn() },
}));
vi.mock('../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentRegistry')>();
  const base = real.fallbackListing();
  const listing: AgentRegistryListing = { ...base, agents: base.agents.filter((a) => a.id === 'claude').map((a) => ({ ...a, installed: true })) };
  return { ...real, useAgentRegistry: () => listing, handleDefinitionsChanged: vi.fn(async () => undefined) };
});
vi.mock('../lib/agentDefinitions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentDefinitions')>();
  return { ...real, tauriAgentDefinitionsApi: { ...real.tauriAgentDefinitionsApi, list: async () => ({ sources: [], definitions: [] }), remove: vi.fn() } };
});
vi.mock('../lib/accounts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/accounts')>();
  return { ...real, tauriAccountsApi: { ...real.tauriAccountsApi, list: async () => ({ agents: [{ agent_id: 'claude', home_env: 'X', login_hint: 'Sign in once.' }], accounts: [], helper_logins: {} }) } };
});
vi.mock('../lib/modelOptions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/modelOptions')>();
  return { ...real, tauriModelOptionsApi: { get: async () => ({ terminal: true, defaultModel: 'sonnet', models: ['opus', 'sonnet'] }) } };
});
vi.mock('../lib/acpChat', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/acpChat')>();
  const agents = [{ id: 'claude', label: 'Claude', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null, saved: true }];
  return { ...real, tauriAcpChatApi: { ...real.tauriAcpChatApi, laneGet: async () => ({ labs_enabled: true, agents }) } };
});
vi.mock('../lib/canary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/canary')>();
  const agent = { agent: 'claude', label: 'Claude', installed: true, version: '2.1.0', tested: null, standing: 'tested', strict: false, strict_reason: null, chip: null, plain: 'Tested.', checking: false, last: null, captures: 0, verified: true, change: null };
  const status = { agents: [agent], auto_check: true, notices: [], captures: 0 };
  return { ...real, tauriCanaryApi: { status: async () => status, check: vi.fn(), setAuto: vi.fn(), dismissNotice: vi.fn(), openCaptures: vi.fn(), onChanged: async () => () => undefined } };
});
vi.mock('../lib/tauri', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tauri')>();
  const status = (config: StandbyConfig) => ({ enabled: config.preload.enabled, config, counts: { total: 0, ready: 0, starting: 0 }, standbys: [], blocked: [], recent: [], stats: {}, supported: [] }) as unknown as StandbyStatus;
  return {
    ...real,
    tauri: {
      ...real.tauri,
      standbyGetStatus: async () => status(mocks.standby.current),
      standbySetConfig: async (config: StandbyConfig) => {
        mocks.setConfig(config);
        mocks.standby.current = config;
        return status(config);
      },
    },
  };
});

let host: HTMLDivElement;
let root: Root;

const makeApi = (): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const page = () => q('[data-testid="agent-page"]');

beforeEach(async () => {
  mocks.standby.current = DEFAULT_STANDBY_CONFIG;
  mocks.setConfig.mockClear();
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsPanel open api={makeApi()} initialTab="agents" />));
  await settle(12);
});
afterEach(async () => {
  setOpenAgent(null);
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings > Agents > one agent page', () => {
  it('the Agents page no longer lists the per-agent rows as separate lists', () => {
    expect(q('[data-row="agent-list"]')).not.toBeNull();
    for (const id of ['agent-default-models', 'agent-lane', 'chat-addons']) expect(q(`[data-row="${id}"]`), id).toBeNull();
    expect(q('[data-testid="agent-model-claude"]')).toBeNull();
    expect(q('select[aria-label="How Claude runs"]')).toBeNull();
    expect(q('[data-testid="agent-version-claude"]')).toBeNull();
    expect(q('[data-testid="preload-providers"]')).toBeNull();
  });

  it('opening Claude shows model, chat or terminal, add-on, version and keep ready', async () => {
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    await settle(8);
    const p = page()!;
    expect(p.getAttribute('data-agent')).toBe('claude');
    expect(p.querySelector('[data-testid="agent-model-claude"]')).not.toBeNull();
    expect(p.querySelector('select[aria-label="How Claude runs"]')).not.toBeNull();
    expect(p.querySelector('[data-testid="chat-adapter-claude"]')).not.toBeNull();
    expect(p.querySelector('[data-testid="agent-version-claude"]')).not.toBeNull();
    const keep = p.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Keep Claude ready"]');
    expect(keep?.getAttribute('aria-checked')).toBe('false');
  });

  it('Keep ready on the agent page turns the warm setting on for that agent, and off again', async () => {
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    await settle(8);
    const keep = () => page()!.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Keep Claude ready"]')!;
    await click(keep());
    await settle(6);
    expect(mocks.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ preload: expect.objectContaining({ enabled: true, providers: { claude: 1 } }) }));
    expect(keep().getAttribute('aria-checked')).toBe('true');
    await click(keep());
    await settle(6);
    expect(mocks.setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ preload: expect.objectContaining({ providers: {} }) }));
    expect(keep().getAttribute('aria-checked')).toBe('false');
  });

  it('old deep links to the moved rows still open the Agents page', async () => {
    const { resolveSettingsTarget } = await import('../lib/settings-target');
    for (const id of ['chat-addons', 'agent-lane', 'agent-default-models']) expect(resolveSettingsTarget(id), id).toEqual({ page: 'agents', row: 'agent-list' });
  });
});
