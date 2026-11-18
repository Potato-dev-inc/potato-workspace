// @vitest-environment jsdom
// Settings > Bridge & MCP > Security: the two switches save through the app's own commands and the
// audit list is read-only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mountRows, settle } from '../test-utils';
import { securityRows, whenText } from './bridge/Security';

const mocks = vi.hoisted(() => ({
  state: { ask_before_agent_control: true, agents_may_merge: false, ask_before_helpers_start: false },
  entries: [
    { seq: 2, ts_ms: Date.now() - 120_000, kind: 'consent', who: 'desktop', summary: 'You allowed Claude to control Codex, once' },
    { seq: 1, ts_ms: Date.now() - 3_600_000, kind: 'approval', who: 'device', summary: 'A phone answered from its lock screen: Allowed once' },
  ],
  verify: { ok: true, entries: 2, broken: null as null | { file: string; line: number; reason: string } },
}));

vi.mock('../../../lib/agent-authority-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agent-authority-api')>();
  return {
    ...real,
    agentAuthorityApi: {
      get: vi.fn(async () => ({ ...mocks.state })),
      set: vi.fn(async (patch: Partial<typeof mocks.state>) => {
        mocks.state = { ...mocks.state, ...patch };
        return { ...mocks.state };
      }),
      auditRecent: vi.fn(async () => mocks.entries),
      auditVerify: vi.fn(async () => mocks.verify),
    },
  };
});

import { agentAuthorityApi } from '../../../lib/agent-authority-api';

const ASK = "Ask me before an agent controls a window it didn't start";
const MERGE = 'Let agents merge separate copies';
const switchFor = (host: HTMLElement, label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`);

beforeEach(() => {
  mocks.state = { ask_before_agent_control: true, agents_may_merge: false, ask_before_helpers_start: false };
  mocks.verify = { ok: true, entries: 2, broken: null };
  vi.clearAllMocks();
});

describe('Security rows', () => {
  it('shows the safe defaults: A on, B off', async () => {
    const m = await mountRows(securityRows);
    await settle(5);
    expect(switchFor(m.host, ASK)?.getAttribute('aria-checked')).toBe('true');
    expect(switchFor(m.host, MERGE)?.getAttribute('aria-checked')).toBe('false');
    await m.unmount();
  });

  it('saves a switch through the app command and keeps the other one', async () => {
    const m = await mountRows(securityRows);
    await settle(5);
    await click(switchFor(m.host, ASK));
    await settle(5);
    expect(agentAuthorityApi.set).toHaveBeenCalledWith({ ask_before_agent_control: false });
    expect(mocks.state).toEqual({ ask_before_agent_control: false, agents_may_merge: false, ask_before_helpers_start: false });
    await click(switchFor(m.host, MERGE));
    await settle(5);
    expect(mocks.state).toEqual({ ask_before_agent_control: false, agents_may_merge: true, ask_before_helpers_start: false });
    expect(switchFor(m.host, MERGE)?.getAttribute('aria-checked')).toBe('true');
    await m.unmount();
  });

  it('has the helpers switch off by default and saves it through the app command only', async () => {
    const m = await mountRows(securityRows);
    await settle(5);
    const label = 'Ask me before other tools start agents';
    expect(switchFor(m.host, label)?.getAttribute('aria-checked')).toBe('false');
    await click(switchFor(m.host, label));
    await settle(5);
    expect(agentAuthorityApi.set).toHaveBeenCalledWith({ ask_before_helpers_start: true });
    expect(mocks.state.ask_before_helpers_start).toBe(true);
    expect(switchFor(m.host, label)?.getAttribute('aria-checked')).toBe('true');
    await m.unmount();
  });

  it('puts a switch back and says so when the save fails', async () => {
    vi.mocked(agentAuthorityApi.set).mockRejectedValueOnce(new Error('disk full'));
    const m = await mountRows(securityRows);
    await settle(5);
    await click(switchFor(m.host, MERGE));
    await settle(5);
    expect(switchFor(m.host, MERGE)?.getAttribute('aria-checked')).toBe('false');
    expect(m.env.setError).toHaveBeenCalledWith('Not saved: disk full');
    await m.unmount();
  });

  it('lists recent approvals read-only, newest first, in plain words', async () => {
    const m = await mountRows(securityRows);
    await settle(5);
    const rows = [...m.host.querySelectorAll('.st-audit-row')];
    expect(rows.map((r) => r.querySelector('.st-audit-what')?.textContent)).toEqual([
      'You allowed Claude to control Codex, once',
      'A phone answered from its lock screen: Allowed once',
    ]);
    expect(rows.map((r) => r.querySelector('.st-audit-who')?.textContent)).toEqual(['You', 'A paired phone']);
    expect(m.host.querySelector('.st-audit')?.querySelectorAll('button, input, select')).toHaveLength(0);
    expect(m.host.textContent).toContain('Log checked: 2 entries, none changed.');
    await m.unmount();
  });

  it('warns when the log was changed', async () => {
    mocks.verify = { ok: false, entries: 1, broken: { file: '2026-10.jsonl', line: 2, reason: 'the line was changed after it was written' } };
    const m = await mountRows(securityRows);
    await settle(5);
    const alert = m.host.querySelector('.st-audit-check[role="alert"]');
    expect(alert?.textContent).toContain('This log was changed after it was written');
    await m.unmount();
  });

  it('formats times as the time today and the date before', () => {
    const noon = new Date(2026, 9, 14, 12, 0).getTime();
    expect(whenText(new Date(2026, 9, 14, 9, 5).getTime(), noon)).toBe('09:05');
    expect(whenText(new Date(2026, 9, 13, 23, 30).getTime(), noon)).toMatch(/13/);
  });

  it('is folded by default, groups repeats, shows the last 10 and Show all, and Clear leaves the log file alone', async () => {
    const t0 = Date.now();
    mocks.entries = [
      ...Array.from({ length: 9 }, (_, i) => ({ seq: 100 - i, ts_ms: t0 - i * 1000, kind: 'pairing', who: 'desktop', summary: 'You made a pairing code for a phone' })),
      ...Array.from({ length: 12 }, (_, i) => ({ seq: 50 - i, ts_ms: t0 - 60_000 - i * 1000, kind: 'setting', who: 'desktop', summary: `You changed setting ${i}` })),
    ];
    mocks.verify = { ok: true, entries: 21, broken: null };
    const m = await mountRows(securityRows);
    await settle(5);
    const fold = m.host.querySelector<HTMLDetailsElement>('[data-testid="audit-fold"]');
    expect(fold?.open).toBe(false);
    const rows = [...m.host.querySelectorAll('.st-audit-row')];
    expect(rows).toHaveLength(10);
    expect(rows[0]?.textContent).toContain('You made a pairing code for a phone ×9');
    await click([...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Show all (13)') as HTMLElement);
    expect(m.host.querySelectorAll('.st-audit-row')).toHaveLength(13);
    await click([...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Clear') as HTMLElement);
    expect(m.host.querySelectorAll('.st-audit-row')).toHaveLength(0);
    expect(m.host.textContent).toContain('The saved log file is not changed');
    expect(m.host.textContent).toContain('Log checked: 21 entries, none changed.');
    expect(agentAuthorityApi.auditVerify).toHaveBeenCalled();
    await click([...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Show cleared lines') as HTMLElement);
    expect(m.host.querySelectorAll('.st-audit-row').length).toBeGreaterThan(0);
    await m.unmount();
  });
});
