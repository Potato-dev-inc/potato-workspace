// @vitest-environment jsdom
// Settings > Agents, as a person meets it: one row per agent with chips, a click opens that agent's page, and the page holds
// everything about that agent. Backends are mocked at the lib level, the way the other Settings screen tests do.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCaps, Cap } from '../../../lib/agentCaps';
import type { AgentRegistryListing } from '../../../lib/agentRegistry';
import { SECTIONS } from '../catalog';
import { click, mountRows, settle, type Mounted } from '../test-utils';
import { openAgentPage, setOpenAgent } from './agentTarget';

const cap = (value: Cap['value'] = 'unknown', source: Cap['source'] = 'unknown'): Cap => ({
  value,
  source,
  proof: value === 'unknown' ? '' : 'a fact',
  at: value === 'unknown' ? null : '2026-11-13T01:00:00Z',
});

function caps(agentId: string, label: string, over: Partial<AgentCaps> = {}): AgentCaps {
  return {
    schema: 1,
    agent_id: agentId,
    label,
    level: 'l0',
    level_proof: cap('yes', 'handshake'),
    program_version: null,
    chat: cap(),
    resume: cap(),
    shows_steps: cap(),
    edits_files: cap(),
    asks_before_edit: cap(),
    asks_before_shell: cap(),
    model_pick: cap(),
    models: [],
    models_total: 0,
    stop: cap(),
    images: cap(),
    usage: cap(),
    read_only: cap(),
    ...over,
  };
}

const mocks = vi.hoisted(() => ({
  capsList: [] as AgentCaps[],
  definitions: [] as { id: string; file: string; source: string; state: string }[],
  remove: vi.fn(async () => ({ ok: true, id: 'claude', label: 'Claude', removed_id: 'r1', fixtures: false, wizard: false, was_approved: true })),
}));

vi.mock('../../../lib/agentCaps', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentCaps')>();
  return {
    ...real,
    agentCapsApi: {
      get: async (id: string) => mocks.capsList.find((c) => c.agent_id === id)!,
      list: async () => mocks.capsList,
      onChanged: () => () => undefined,
    },
  };
});
vi.mock('../../../lib/agent-health', () => ({
  agentHealthApi: {
    check: async () => [
      { id: 'claude', label: 'Claude', state: 'ready', installed: true, version: '2.1.0', reason: '', install_hint: null, login_hint: null, can_test: true },
      { id: 'kimi', label: 'Kimi', state: 'needs_login', installed: true, version: null, reason: '', install_hint: null, login_hint: 'Run kimi once and sign in.', can_test: false },
    ],
    test: vi.fn(),
  },
}));
vi.mock('../../../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRegistry')>();
  const agent = (id: string, label: string, kind = 'cli') => ({ id, label, icon: null, installed: true, kind }) as unknown as AgentRegistryListing['agents'][number];
  const listing = { ...real.fallbackListing(), agents: [agent('claude', 'Claude'), agent('kimi', 'Kimi'), agent('powershell', 'PowerShell', 'shell')] };
  return { ...real, useAgentRegistry: () => listing, handleDefinitionsChanged: vi.fn(async () => undefined) };
});
vi.mock('../../../lib/agentDefinitions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentDefinitions')>();
  return { ...real, tauriAgentDefinitionsApi: { ...real.tauriAgentDefinitionsApi, list: async () => ({ sources: [], definitions: mocks.definitions }), remove: mocks.remove } };
});
vi.mock('../../../lib/accounts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/accounts')>();
  const agents = ['claude', 'kimi'].map((agent_id) => ({ agent_id, home_env: 'X', login_hint: 'Sign in once.' }));
  return { ...real, tauriAccountsApi: { ...real.tauriAccountsApi, list: async () => ({ agents, accounts: [], helper_logins: {} }) } };
});
vi.mock('../../../lib/modelOptions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/modelOptions')>();
  return { ...real, tauriModelOptionsApi: { get: async () => ({ terminal: true, defaultModel: 'sonnet', models: ['opus', 'sonnet'] }) } };
});
vi.mock('../../../lib/acpChat', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/acpChat')>();
  const agents = [
    { id: 'claude', label: 'Claude', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null, saved: true },
    { id: 'kimi', label: 'Kimi', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null, saved: true },
  ];
  return { ...real, tauriAcpChatApi: { ...real.tauriAcpChatApi, laneGet: async () => ({ labs_enabled: true, agents }) } };
});
vi.mock('../../../lib/canary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/canary')>();
  const agent = (id: string, label: string) => ({
    agent: id, label, installed: true, version: '1.0', tested: null, standing: 'tested', strict: false, strict_reason: null,
    chip: null, plain: 'Tested.', checking: false, last: null, captures: 0, verified: true, change: null,
  });
  const status = { agents: [agent('claude', 'Claude'), agent('kimi', 'Kimi')], auto_check: true, notices: [], captures: 0 };
  return {
    ...real,
    tauriCanaryApi: { status: async () => status, check: vi.fn(), setAuto: vi.fn(), dismissNotice: vi.fn(), openCaptures: vi.fn(), onChanged: async () => () => undefined },
  };
});

const listRow = SECTIONS.find((s) => s.id === 'agents')!.rows.filter((r) => r.id === 'agent-list');
let m: Mounted;

beforeEach(() => {
  mocks.capsList = [
    caps('claude', 'Claude', { chat: cap('yes', 'definition'), resume: cap('yes', 'handshake'), asks_before_edit: cap('no', 'seen'), model_pick: cap('yes', 'handshake') }),
    caps('kimi', 'Kimi', { level: 'l5', chat: cap('no', 'check') }),
  ];
  mocks.definitions = [{ id: 'claude', file: 'C:/agents/claude.toml', source: 'user', state: 'active' }];
  mocks.remove.mockClear();
});
afterEach(async () => {
  setOpenAgent(null);
  await m?.unmount();
});

const mount = async () => {
  m = await mountRows(listRow);
  await settle(12);
};
const q = (sel: string) => m.host.querySelector<HTMLElement>(sel);
const page = () => q('[data-testid="agent-page"]');
const chipsOf = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-chip]')];

describe('Settings > Agents', () => {
  it('agents list shows one row per agent with chips', async () => {
    await mount();
    expect(listRow).toHaveLength(1);
    const rows = [...m.host.querySelectorAll('.ag-row')];
    expect(rows.map((r) => r.getAttribute('data-agent'))).toEqual(['claude', 'kimi']);
    const claude = q('[data-testid="agent-row-claude"]')!;
    expect(claude.textContent).toContain('Claude');
    expect(claude.textContent).toContain('Ready');
    // The list shows plain grey words, no pills; the page shows the pills.
    expect(chipsOf(claude)).toHaveLength(0);
    expect(claude.querySelector('.ag-chips-text')?.textContent).toBe('Can chat · Remembers the chat · Can pick a model');
    const kimi = q('[data-testid="agent-row-kimi"]')!;
    expect(kimi.textContent).toContain('Not signed in');
    expect(kimi.querySelector('.ag-step')?.textContent).toBe('Sign in');
    expect(kimi.textContent).toContain('Terminal only');
    expect(chipsOf(kimi)).toHaveLength(0);
  });

  it('clicking an agent opens its page', async () => {
    await mount();
    expect(page()).toBeNull();
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    expect(page()?.getAttribute('data-agent')).toBe('claude');
    expect(q('.ag-row')).toBeNull();
    expect(page()?.querySelector('.ag-title')?.textContent).toBe('Claude');
    // The window's title carries the name now; the page has no Status row and no Back button of its own.
    expect(page()?.textContent).not.toContain('Status');
  });

  it('agent page never shows a tick for an unknown capability', async () => {
    mocks.capsList = [caps('claude', 'Claude', { chat: cap('yes', 'definition'), stop: cap('yes', 'unknown'), images: cap('no', 'unknown') })];
    await mount();
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    const all = chipsOf(page()!);
    expect(all).toHaveLength(10);
    const ticks = all.filter((c) => c.textContent?.includes('✓'));
    expect(ticks.map((c) => c.getAttribute('data-chip'))).toEqual(['chat']);
    // A yes or a no with nothing to back it is not drawn as one.
    for (const key of ['stop', 'images', 'usage', 'shows_steps']) {
      const chip = page()!.querySelector(`[data-chip="${key}"]`)!;
      expect(chip.getAttribute('data-value'), key).toBe('unknown');
      expect(chip.textContent, key).not.toMatch(/[✓✕]/);
    }
    expect(page()!.textContent).toContain('Fills in after your first chat:');
    // Known chips come before the caption, the unknown ones after it.
    const html = page()!.innerHTML;
    expect(html.indexOf('data-chip="chat"')).toBeLessThan(html.indexOf('Fills in after your first chat:'));
    expect(html.indexOf('Fills in after your first chat:')).toBeLessThan(html.indexOf('data-chip="stop"'));
  });

  it('agent page holds sign-ins, default model, opening mode, version and remove', async () => {
    await mount();
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    const p = page()!;
    expect(p.querySelector('[data-testid="accounts-claude"]')).not.toBeNull();
    expect(p.querySelector('[data-testid="agent-model-claude"]')).not.toBeNull();
    expect(p.querySelector('[data-testid="helper-model-claude"]')).not.toBeNull();
    expect(p.querySelector('select[aria-label="How Claude runs"]')).not.toBeNull();
    expect(p.querySelector('[data-testid="agent-version-claude"]')).not.toBeNull();
    expect(p.querySelector('button[aria-label="Remove Claude"]')).not.toBeNull();
    // Only this agent: nothing of the other one.
    expect(p.querySelector('[data-testid="accounts-kimi"]')).toBeNull();
    expect(p.querySelector('[data-testid="agent-model-kimi"]')).toBeNull();
    expect(p.querySelector('[data-testid="agent-version-kimi"]')).toBeNull();
    expect(p.textContent).toContain('Sign in');
  });

  it('a terminal-only agent says so instead of showing chips, and opens in a terminal', async () => {
    await mount();
    await click(q('[data-testid="agent-row-kimi"] .ag-open'));
    const p = page()!;
    expect(chipsOf(p)).toHaveLength(0);
    expect(p.textContent).toContain('works in a terminal window only');
    expect(p.textContent).toContain('How it opens');
    expect(p.querySelector('select[aria-label="How Kimi runs"]')).toBeNull();
    expect(p.textContent).toContain('Not signed in');
    expect(p.textContent).toContain('Run kimi once and sign in.');
    // Comes with Potato: no Remove row at all.
    expect(p.querySelector('button[aria-label="Remove Kimi"]')).toBeNull();
    expect(p.textContent).not.toContain('Remove Kimi');
  });

  it('deep link opens the agent page', async () => {
    openAgentPage('kimi'); // before the list is on screen
    await mount();
    expect(page()?.getAttribute('data-agent')).toBe('kimi');
    await act(async () => openAgentPage('claude')); // while it is on screen
    await settle(6);
    expect(page()?.getAttribute('data-agent')).toBe('claude');
  });

  it('back returns to the list', async () => {
    await mount();
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    expect(page()).not.toBeNull();
    await act(async () => setOpenAgent(null)); // the Settings window's "Agents" in the title does this
    expect(page()).toBeNull();
    expect(m.host.querySelectorAll('.ag-row')).toHaveLength(2);
  });

  it('remove asks to confirm', async () => {
    await mount();
    await click(q('[data-testid="agent-row-claude"] .ag-open'));
    m.env.confirm.mockResolvedValueOnce(false);
    await click(page()!.querySelector('button[aria-label="Remove Claude"]'));
    await settle();
    expect(m.env.confirm).toHaveBeenCalledTimes(1);
    expect(m.env.confirm.mock.calls[0][0]).toMatchObject({ title: 'Remove Claude?', confirmLabel: 'Remove' });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(page()).not.toBeNull();
    await click(page()!.querySelector('button[aria-label="Remove Claude"]'));
    await settle(6);
    expect(mocks.remove).toHaveBeenCalledWith('C:/agents/claude.toml');
    expect(page()).toBeNull();
  });
});
