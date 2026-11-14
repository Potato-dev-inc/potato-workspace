import { describe, expect, it } from 'vitest';
import type { AcpLaneView } from './acpChat';
import type { AgentHealth } from './agent-health';
import { LOW_DISK_BYTES, runStartupCheck, type StartupDeps } from './startup-check';

const agent = (id: string, over: Partial<AgentHealth> = {}): AgentHealth => ({
  id,
  label: id === 'codex' ? 'Codex' : 'Claude',
  state: 'ready',
  installed: true,
  version: '1',
  reason: '',
  install_hint: null,
  login_hint: null,
  can_test: true,
  ...over,
});

const lanes = (chatIds: string[]): AcpLaneView =>
  ({ labs_enabled: true, agents: chatIds.map((id) => ({ id, label: id, lane: 'acp', effective_lane: 'acp' })) }) as unknown as AcpLaneView;

/** Everything is fine unless a test says otherwise. */
const fine = (over: Partial<StartupDeps> = {}): StartupDeps => ({
  agentHealth: async () => [agent('claude'), agent('codex')],
  bridgeUp: () => true,
  diskFreeBytes: async () => 50 * 1024 ** 3,
  updateReachable: async () => true,
  lanes: async () => lanes(['claude', 'codex']),
  settings: async () => ({ show_terminals: false, acp_chat_enabled: true }),
  ...over,
});

describe('the quiet start-up check', () => {
  it('says nothing when all five things are fine', async () => {
    expect(await runStartupCheck(fine())).toEqual([]);
  });

  it('an installed agent that is not signed in gets one line with a Sign in fix', async () => {
    const lines = await runStartupCheck(fine({ agentHealth: async () => [agent('claude'), agent('codex', { state: 'needs_login' })] }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ id: 'agents', text: 'Codex needs sign-in', fix: { kind: 'signin', agentId: 'codex', label: 'Sign in' } });
  });

  it('an agent that is not installed is not a problem', async () => {
    const lines = await runStartupCheck(fine({ agentHealth: async () => [agent('claude'), agent('codex', { installed: false, state: 'not_installed' })] }));
    expect(lines).toEqual([]);
  });

  it('the bridge being down gives a line that opens Check my setup', async () => {
    const lines = await runStartupCheck(fine({ bridgeUp: () => false }));
    expect(lines.map((l) => l.id)).toEqual(['bridge']);
    expect(lines[0].fix).toMatchObject({ kind: 'settings', page: 'overview' });
  });

  it('low disk space says how much is left, and an unknown answer says nothing', async () => {
    const low = await runStartupCheck(fine({ diskFreeBytes: async () => LOW_DISK_BYTES - 1 }));
    expect(low.map((l) => l.id)).toEqual(['disk']);
    expect(low[0].text).toContain('2 GB left');
    expect(await runStartupCheck(fine({ diskFreeBytes: async () => null }))).toEqual([]);
    expect(await runStartupCheck(fine({ diskFreeBytes: async () => LOW_DISK_BYTES }))).toEqual([]);
  });

  it('an unreachable update address gives one line', async () => {
    const lines = await runStartupCheck(fine({ updateReachable: async () => false }));
    expect(lines.map((l) => l.id)).toEqual(['update']);
  });

  it('terminals hidden while every agent is terminal-only gives a Show terminals line; one chat-capable agent is enough', async () => {
    const stuck = await runStartupCheck(fine({ lanes: async () => lanes([]) }));
    expect(stuck.map((l) => l.id)).toEqual(['terminals']);
    expect(stuck[0].fix?.kind).toBe('terminals');
    expect(await runStartupCheck(fine({ lanes: async () => lanes(['codex']) }))).toEqual([]);
    // Terminals shown: nothing is inconsistent.
    expect(await runStartupCheck(fine({ lanes: async () => lanes([]), settings: async () => ({ show_terminals: true }) }))).toEqual([]);
    // Chat itself off: terminals are shown by rule.
    expect(await runStartupCheck(fine({ lanes: async () => lanes([]), settings: async () => ({ show_terminals: false, acp_chat_enabled: false }) }))).toEqual([]);
  });

  it('a check that cannot read its answer says nothing and never stops the others', async () => {
    const boom = async () => {
      throw new Error('no');
    };
    const lines = await runStartupCheck(
      fine({ agentHealth: boom, diskFreeBytes: boom, lanes: boom, settings: boom, updateReachable: async () => false }),
    );
    expect(lines.map((l) => l.id)).toEqual(['update']);
  });
});
