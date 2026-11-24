// @vitest-environment jsdom
// The page: rows from the checks, one fix button per problem calls its action, Copy report sends scrubbed text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddonList } from '../../lib/acpAddon';
import type { AgentHealth } from '../../lib/agent-health';
import type { SetupCheckDeps } from '../../lib/setup-checks';
import type { RowDef } from './model';
import { SetupCheckPage, type SetupCheckActions } from './SetupCheckPage';
import { buttonByText, click, hasText, mountRows, settle } from './test-utils';

const deps = (over: Partial<SetupCheckDeps> = {}): SetupCheckDeps => ({
  agentHealth: async (): Promise<AgentHealth[]> => [
    {
      id: 'claude',
      label: 'Claude',
      state: 'needs_login',
      installed: true,
      version: '1',
      reason: 'Needs sign-in at C:\\Users\\someone\\work',
      install_hint: null,
      login_hint: null,
      can_test: true,
    },
  ],
  addons: async (): Promise<AddonList> => ({ labsEnabled: false, addons: [] }),
  ...over,
});

const actions = (): SetupCheckActions => ({
  signIn: vi.fn(),
  installAddon: vi.fn(),
});

const pageRow = (
  d: SetupCheckDeps,
  a: SetupCheckActions,
  copy?: (t: string) => Promise<void>,
  labs: Record<string, boolean> = {},
): RowDef => ({
  id: 'setup-check',
  label: 'Check my setup',
  render: () => <SetupCheckPage ctx={{ bridgeUrl: 'http://127.0.0.1:1', labs }} deps={d} actions={a} copy={copy} />,
});

describe('SetupCheckPage', () => {
  it('shows the rows and calls the matching fix action', async () => {
    const a = actions();
    const m = await mountRows([pageRow(deps(), a)]);
    await settle(6);
    expect(hasText(m.host, 'Potato Workspace is running')).toBe(true);
    expect(hasText(m.host, 'Claude needs sign-in')).toBe(true);
    await click(buttonByText(m.host, 'Sign in'));
    expect(a.signIn).toHaveBeenCalledWith('claude');
    await m.unmount();
  });

  it('Copy report sends the rows with the path and key removed', async () => {
    const copy = vi.fn(async () => {});
    const m = await mountRows([pageRow(deps(), actions(), copy)]);
    await settle(6);
    await click(buttonByText(m.host, 'Copy report'));
    await settle();
    const sent = (copy.mock.calls as unknown as string[][])[0]?.[0] ?? '';
    expect(sent).toContain('Claude needs sign-in');
    expect(sent).not.toContain('someone');
    expect(hasText(m.host, 'Report copied')).toBe(true);
    await m.unmount();
  });

  const row = (id: string, label: string, over: Partial<AgentHealth> = {}): AgentHealth => ({
    id, label, state: 'unchecked', installed: true, version: '1', reason: 'Installed.', install_hint: null, login_hint: null, can_test: true, ...over,
  });
  const many = (): SetupCheckDeps =>
    deps({
      agentHealth: async () => [
        row('claude', 'Claude'),
        row('opencode', 'OpenCode', { can_test: false }),
        row('gemini', 'Gemini', { installed: false, state: 'not_installed' }),
      ],
    });

  it('every row has a button, an untestable one opens the agent, a missing one offers Install, nothing counts it as to check', async () => {
    const a = { ...actions(), test: vi.fn(), open: vi.fn(), install: vi.fn() };
    const m = await mountRows([pageRow(many(), a)]);
    await settle(6);
    expect(hasText(m.host, 'Claude is not checked yet')).toBe(true);
    expect(hasText(m.host, 'OpenCode is installed')).toBe(true);
    expect(hasText(m.host, 'Gemini is not installed')).toBe(true);
    expect(hasText(m.host, '1 to check')).toBe(true);
    await click(buttonByText(m.host, 'Open it'));
    expect(a.open).toHaveBeenCalledWith('opencode');
    await click(buttonByText(m.host, 'Install'));
    expect(a.install).toHaveBeenCalledWith('gemini');
    await click(buttonByText(m.host, 'Test'));
    expect(a.test).toHaveBeenCalledWith('claude');
    await m.unmount();
  });

  it('Check again tests every agent that can be tested, then reads the list', async () => {
    const a = { ...actions(), test: vi.fn(async () => {}) };
    const d = deps({ agentHealth: async () => [row('claude', 'Claude'), row('codex', 'Codex'), row('aider', 'Aider', { can_test: false })] });
    const m = await mountRows([pageRow(d, a)]);
    await settle(6);
    await click(buttonByText(m.host, 'Check again'));
    await settle(6);
    expect(a.test).toHaveBeenCalledTimes(2);
    expect(a.test).toHaveBeenNthCalledWith(1, 'claude');
    expect(a.test).toHaveBeenNthCalledWith(2, 'codex');
    await m.unmount();
  });

  it('shows the saved answer at once with its age, and does not read again while it is fresh', async () => {
    const first = deps();
    const m1 = await mountRows([pageRow(first, actions())]);
    await settle(6);
    await m1.unmount();
    const again = vi.fn(async () => []);
    const m2 = await mountRows([pageRow(deps({ agentHealth: again }), actions())]);
    await settle(2);
    expect(hasText(m2.host, 'Claude needs sign-in')).toBe(true);
    expect(hasText(m2.host, 'Checked just now')).toBe(true);
    expect(again).not.toHaveBeenCalled();
    expect(hasText(m2.host, 'Checking')).toBe(false);
    await m2.unmount();
  });

  it('reads again in the background when the saved answer is older than ten minutes', async () => {
    window.localStorage.setItem(
      'pm.setupcheck.rows.v1',
      JSON.stringify({ at: Date.now() - 11 * 60_000, lang: 'en', groups: [{ id: 'agents', rows: [{ id: 'agent-claude', status: 'ok', sentence: 'Old answer', fix: null }] }] }),
    );
    let release: (v: AgentHealth[]) => void = () => {};
    const read = vi.fn(() => new Promise<AgentHealth[]>((resolve) => (release = resolve)));
    const m = await mountRows([pageRow(deps({ agentHealth: read }), actions())]);
    expect(hasText(m.host, 'Old answer')).toBe(true);
    expect(m.host.querySelector('[data-busy="true"]')).not.toBeNull();
    release([]);
    await settle(6);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hasText(m.host, 'Old answer')).toBe(false);
    await m.unmount();
  });

  it('rows appear as each check finishes, and a slow one has its own spinner row', async () => {
    let release: (v: AgentHealth[]) => void = () => {};
    const slow = new Promise<AgentHealth[]>((resolve) => (release = resolve));
    const m = await mountRows([pageRow(deps({ agentHealth: () => slow }), actions())]);
    await settle(3);
    expect(hasText(m.host, 'Potato Workspace is running')).toBe(true);
    expect(m.host.querySelector('[data-status="checking"]')).not.toBeNull();
    expect(hasText(m.host, 'Checking your agents')).toBe(true);
    release([]);
    await settle(6);
    expect(m.host.querySelector('[data-status="checking"]')).toBeNull();
    await m.unmount();
  });

  it('a check that never answers says why instead of hanging', async () => {
    vi.useFakeTimers();
    const m = await mountRows([pageRow(deps({ agentHealth: () => new Promise<AgentHealth[]>(() => {}) }), actions())]);
    await vi.advanceTimersByTimeAsync(9000);
    await settle(3);
    expect(hasText(m.host, 'your agents did not answer in time')).toBe(true);
    await m.unmount();
  });

  afterEach(() => vi.useRealTimers());
});
