// Each check maps its status read to rows; a failing read shows "Can't check this yet"; the report is scrubbed.
import { describe, expect, it } from 'vitest';
import type { AddonList } from '../acpAddon';
import type { AgentHealth } from '../agent-health';
import { checkAddons } from './addons';
import { checkAgents } from './agents';
import { checkBridge } from './bridge';
import { buildReport, redactReport, runAllChecks, CANT_CHECK_YET, type SetupCheckDeps } from './index';

const agent = (over: Partial<AgentHealth>): AgentHealth => ({
  id: 'codex',
  label: 'Codex',
  state: 'ready',
  installed: true,
  version: '1.0',
  reason: 'Ready to use.',
  install_hint: null,
  login_hint: null,
  can_test: true,
  ...over,
});

type Addon = AddonList['addons'][number];
const addon = (over: Partial<Addon>): Addon => ({
  agent: 'claude',
  label: 'Claude',
  state: 'installed',
  version: '2.0.1',
  pinned_version: '2.0.1',
  detail: '',
  size_mb: 48,
  lines: [],
  signin_hint: '',
  ...over,
});

const ctx = (over: Partial<{ bridgeUrl: string | null; labs: Record<string, boolean> }> = {}) => ({
  bridgeUrl: 'http://127.0.0.1:9000',
  labs: {},
  ...over,
});

describe('setup checks: mapping', () => {
  it('bridge is ok when its address is known, a fail when not', () => {
    expect(checkBridge(ctx())[0]).toMatchObject({ status: 'ok', sentence: 'Potato Workspace is running', fix: null });
    expect(checkBridge(ctx({ bridgeUrl: null }))[0].status).toBe('fail');
  });

  it('agents: ready is ok, needs login has a Sign in fix, not installed is quiet', () => {
    const rows = checkAgents([
      agent({}),
      agent({ id: 'claude', label: 'Claude', state: 'needs_login', reason: 'Sign in first.' }),
      agent({ id: 'gemini', label: 'Gemini', installed: false, state: 'not_installed' }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ id: 'agentoff-gemini', status: 'quiet', sentence: 'Gemini is not installed' });
    expect(rows[0]).toMatchObject({ status: 'ok', sentence: 'Codex is signed in', fix: null });
    expect(rows[1]).toMatchObject({
      status: 'warn',
      sentence: 'Claude needs sign-in',
      fix: { kind: 'signin', label: 'Sign in', agentId: 'claude' },
    });
  });

  it('add-ons: old version gets Update, missing gets Install, up to date has no fix', () => {
    const rows = checkAddons({
      labsEnabled: true,
      addons: [
        addon({}),
        addon({ agent: 'codex', label: 'Codex', version: '0.9', pinned_version: '1.0' }),
        addon({ agent: 'x', label: 'X', state: 'not_installed', version: null }),
      ],
    });
    expect(rows[0]).toMatchObject({ status: 'ok', fix: null });
    expect(rows[1]).toMatchObject({
      status: 'warn',
      sentence: 'Chat add-on for Codex is old',
      fix: { kind: 'installAddon', label: 'Update', agentId: 'codex' },
    });
    expect(rows[2].fix).toEqual({ kind: 'installAddon', label: 'Install', agentId: 'x' });
  });

  it('never uses the word Bridge, and the failing row says what to do', () => {
    const text = [...checkBridge(ctx()), ...checkBridge(ctx({ bridgeUrl: null }))].map((r) => r.sentence).join(' ');
    expect(text).not.toMatch(/bridge/i);
    expect(checkBridge(ctx({ bridgeUrl: null }))[0].sentence).toContain('needs a restart');
  });

  it('an agent that did not start names the agent and offers Try again; an untested one offers Test', () => {
    const rows = checkAgents([
      agent({ state: 'error', reason: 'Found it, but it did not start properly: exit code 1' }),
      agent({ id: 'claude', label: 'Claude', state: 'unchecked', reason: '' }),
    ]);
    expect(rows[0]).toMatchObject({ status: 'fail', sentence: 'Codex was found but did not start (exit code 1)', fix: { kind: 'test', label: 'Try again', agentId: 'codex' } });
    expect(rows[1]).toMatchObject({ status: 'warn', sentence: 'Claude is not tested yet', fix: { kind: 'test', label: 'Test', agentId: 'claude' } });
  });

  it('there is no Labs row in the list', async () => {
    const rows = await runAllChecks({ agentHealth: async () => [], addons: async () => ({ labsEnabled: true, addons: [] }) }, ctx({ labs: { night_shift_enabled: true } }));
    expect(rows.map((r) => r.id)).not.toContain('labs');
  });
});

describe('runAllChecks', () => {
  const okDeps: SetupCheckDeps = {
    agentHealth: async () => [agent({})],
    addons: async () => ({ labsEnabled: true, addons: [addon({})] }),
  };

  it('shows "Can\'t check this yet" for a check whose read fails, and keeps the others', async () => {
    const rows = await runAllChecks({ ...okDeps, agentHealth: () => Promise.reject(new Error('no read')) }, ctx());
    expect(rows.find((r) => r.id === 'agents')).toMatchObject({ status: 'warn', sentence: CANT_CHECK_YET, fix: null });
    expect(rows.some((r) => r.id === 'bridge')).toBe(true);
  });

  it('skips the add-on check while its Labs switch is off', async () => {
    const rows = await runAllChecks(okDeps, ctx());
    expect(rows.map((r) => r.id)).not.toContain('addon-claude');
    const on = await runAllChecks(okDeps, ctx({ labs: { acp_chat_enabled: true } }));
    expect(on.map((r) => r.id)).toEqual(expect.arrayContaining(['addon-claude']));
  });
});

describe('Copy report redaction', () => {
  it('removes a folder path with a user name and a key-looking string', () => {
    const out = redactReport('Failed at C:\\Users\\someone\\Desktop\\notes.txt with sk-abcdef1234567890XYZ');
    expect(out).not.toContain('someone');
    expect(out).not.toContain('sk-abcdef');
    expect(out).toContain('[key removed]');
  });

  it('the full report has no user name or key from the rows', () => {
    const report = buildReport(
      [{ id: 'a', status: 'fail', sentence: 'Problem in C:\\Users\\someone\\AppData\\app with sk-test1234567890abc', fix: null }],
      '1.2.3',
      '2026-11-02 10:00',
    );
    expect(report).toContain('[PROBLEM]');
    expect(report).not.toContain('someone');
    expect(report).not.toContain('sk-test');
  });
});

describe('agent rows: every agent has an action and the last Test is remembered', () => {
  const unchecked = (over: Partial<AgentHealth>) => agent({ state: 'unchecked', ...over });

  it('an untested agent has Test; one that cannot be tested says why and offers Open it', () => {
    const rows = checkAgents([
      unchecked({ id: 'claude', label: 'Claude' }),
      unchecked({ id: 'opencode', label: 'OpenCode', can_test: false }),
      unchecked({ id: 'aider', label: 'Aider', can_test: false }),
    ]);
    expect(rows[0]).toMatchObject({ status: 'warn', sentence: 'Claude is not tested yet', fix: { kind: 'test', agentId: 'claude' } });
    for (const r of rows.slice(1)) {
      expect(r.status).toBe('ok'); // not a "to check"
      expect(r.sentence).toContain('cannot be tested here');
      expect(r.fix).toMatchObject({ kind: 'open' });
    }
  });

  it('a remembered good Test shows the time and Test again; a bad one shows the reason and Try again', () => {
    const at = new Date(2026, 10, 13, 14, 5).getTime();
    const rows = checkAgents(
      [unchecked({ id: 'claude', label: 'Claude' }), unchecked({ id: 'codex', label: 'Codex' }), unchecked({ id: 'x', label: 'X' })],
      {
        claude: { state: 'ready', reason: 'Ready.', at },
        codex: { state: 'error', reason: 'It failed: boom.', at },
        x: { state: 'needs_login', reason: 'sign in', at },
      },
    );
    expect(rows[0]).toMatchObject({ status: 'ok', fix: { kind: 'test', label: 'Test again' } });
    expect(rows[0].sentence).toMatch(/^Claude works \(tested .*\d.*\)$/);
    expect(rows[1]).toMatchObject({ status: 'fail', fix: { kind: 'test', label: 'Try again' } });
    expect(rows[1].sentence).toContain('It failed: boom (');
    expect(rows[2]).toMatchObject({ status: 'warn', fix: { kind: 'signin' } });
  });

  it('runAllChecks reads the remembered results from deps', async () => {
    const d: SetupCheckDeps = {
      agentHealth: async () => [unchecked({ id: 'claude', label: 'Claude' })],
      addons: async () => ({ labsEnabled: false, addons: [] }),
      tests: () => ({ claude: { state: 'ready', reason: 'Ready.', at: Date.now() } }),
    };
    const rows = await runAllChecks(d, ctx());
    expect(rows.find((r) => r.id === 'agent-claude')?.status).toBe('ok');
  });
});
