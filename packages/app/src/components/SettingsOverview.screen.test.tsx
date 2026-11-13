// @vitest-environment jsdom
// The Settings Overview page with the REAL catalog: the cards and the Setup list read ONE source, so they never
// disagree, and no basic page says "Bridge".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import type { CheckRow } from '../lib/setup-checks';
import { fakeOverviewSources } from './settings/overview-test-utils';
import { BASE_SETTINGS, click, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

let host: HTMLDivElement;
let root: Root;

const api = (): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});

const MIXED: CheckRow[] = [
  { id: 'bridge', status: 'fail', sentence: 'Potato Workspace needs a restart. Close it and open it again.', fix: null },
  { id: 'agent-claude', status: 'warn', sentence: 'Claude is not tested yet', fix: { kind: 'test', label: 'Test', agentId: 'claude' } },
  { id: 'agent-codex', status: 'warn', sentence: 'Codex needs sign-in', fix: { kind: 'signin', label: 'Sign in', agentId: 'codex' } },
  { id: 'agent-gemini', status: 'fail', sentence: 'Gemini was found but did not start (exit code 1)', fix: { kind: 'test', label: 'Try again', agentId: 'gemini' } },
];

async function mount(checks: () => Promise<CheckRow[]>) {
  const sources = fakeOverviewSources({
    checks,
    accounts: async () => ({
      // The sign-in list says everyone has a login. The setup list knows better.
      agents: ['claude', 'codex', 'gemini'].map((agent_id) => ({ agent_id, login_hint: '', home_env: '' })),
      accounts: ['claude', 'codex', 'gemini'].map((agent_id) => ({ id: agent_id, agent_id, label: 'Personal', home: '' })),
    }),
  });
  await act(async () => {
    root.render(<SettingsPanel open initialTab="overview" api={api()} overviewSources={sources} />);
  });
  await settle(10);
}

const card = (id: string) => host.querySelector<HTMLElement>(`[data-card="${id}"]`)!;
const listRows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="setup-check"] .st-setupcheck-row')];

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings > Overview on the real page', () => {
  it('overview cards and setup list never disagree', async () => {
    const run = vi.fn(async () => MIXED);
    await mount(run);
    const rows = listRows();
    // One source: the checks ran once for both.
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(MIXED.length);
    const fixCount = rows.filter((r) => r.dataset.status === 'fail').length;
    const checkCount = rows.filter((r) => r.dataset.status === 'warn').length;
    // The Agents card counts exactly what the list marks.
    expect(card('agents').textContent).toContain(`${fixCount} things need a fix, ${checkCount} to check`);
    // The list header says the same words.
    expect(host.querySelector('.st-setupcheck-summary')!.textContent).toBe(`${fixCount} things need a fix, ${checkCount} to check`);
    // Every agent the list says is not fine is not "signed in" on the Signed in card, even if it has a login saved.
    const signed = card('signed-in').textContent ?? '';
    expect(signed).toContain('Codex');
    expect(signed).toContain('not signed in');
    expect(signed).not.toMatch(/Codex and|and Codex are signed in/);
    // Cards that need a fix come first.
    const order = [...host.querySelectorAll('.st-card')].map((c) => c.getAttribute('data-card'));
    expect(order.slice(0, 2)).toEqual(['agents', 'signed-in']);
  });

  it('when everything is fine, both say so', async () => {
    await mount(async () => [
      { id: 'bridge', status: 'ok', sentence: 'Potato Workspace is running', fix: null },
      { id: 'agent-claude', status: 'ok', sentence: 'Claude is signed in', fix: null },
      { id: 'agent-codex', status: 'ok', sentence: 'Codex is signed in', fix: null },
      { id: 'agent-gemini', status: 'ok', sentence: 'Gemini is signed in', fix: null },
    ]);
    expect(card('agents').textContent).toContain('3 agents ready');
    expect(card('signed-in').textContent).toContain('Claude, Codex and Gemini are signed in');
    expect(host.querySelector('.st-setupcheck-summary')!.textContent).toBe('Everything works');
  });

  it('pressing Test on a row re-runs the one source, and the cards follow', async () => {
    let tested = false;
    const run = vi.fn(async (): Promise<CheckRow[]> => [
      tested
        ? { id: 'agent-claude', status: 'ok', sentence: 'Claude is signed in', fix: null }
        : { id: 'agent-claude', status: 'warn', sentence: 'Claude is not tested yet', fix: { kind: 'test', label: 'Test', agentId: 'claude' } },
    ]);
    const test = vi.fn(async () => {
      tested = true;
    });
    const sources = fakeOverviewSources({ checks: run, actions: { signIn: () => undefined, installAddon: async () => undefined, test } });
    await act(async () => {
      root.render(<SettingsPanel open initialTab="overview" api={api()} overviewSources={sources} />);
    });
    await settle(10);
    expect(card('agents').textContent).toContain('1 to check');
    const button = [...listRows()[0].querySelectorAll('button')].find((b) => b.textContent === 'Test');
    await click(button);
    await settle(10);
    expect(test).toHaveBeenCalledWith('claude');
    expect(run).toHaveBeenCalledTimes(2);
    expect(card('agents').textContent).toContain('1 agent ready');
  });

  it('the Overview page never says Bridge', async () => {
    await mount(async () => MIXED);
    expect(host.querySelector('.st-main')!.textContent).not.toMatch(/bridge/i);
  });
});
