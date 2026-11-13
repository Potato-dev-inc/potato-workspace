// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import type { AgentHealth } from '../../lib/agent-health';
import { runAllChecks } from '../../lib/setup-checks';
import { UpdateNoticeView } from '../updates/UpdateNotice';
import type { AppUpdateState } from '../updates/useAppUpdate';
import { runningJobWarning } from '../../lib/app-update';
import { fakeOverviewSources } from './overview-test-utils';
import { BASE_SETTINGS, settle } from './test-utils';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';

vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, autostartGet: vi.fn(async () => false), autostartSet: vi.fn(async () => undefined) } };
});

let host: HTMLDivElement;
let root: Root;

const api = (): SettingsApi => ({
  load: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  patch: vi.fn(async () => ({ ...BASE_SETTINGS }) as Settings),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});

beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

const agent = (over: Partial<AgentHealth>): AgentHealth => ({
  id: 'codex', label: 'Codex', state: 'ready', installed: true, version: '1.0', reason: 'ok', install_hint: null, login_hint: null, can_test: true, ...over,
});

async function mountWith(agents: AgentHealth[]) {
  const sources = fakeOverviewSources({
    checks: (deps, ctx) => runAllChecks(deps, ctx),
    setupDeps: { agentHealth: async () => agents, addons: async () => ({ addons: [] }) as never },
  });
  await act(async () => {
    root.render(<SettingsPanel open initialTab="overview" api={api()} overviewSources={sources} onClose={() => undefined} />);
  });
  await settle(10);
  return host.querySelector('.st-main')!;
}

const ALLOW = ['Claude', 'Codex', 'Win', 'English'];

describe('Settings Overview in Traditional Chinese', () => {
  it('everything works: setup list, version and what is new have no visible English', async () => {
    const main = await mountWith([agent({ id: 'claude', label: 'Claude' }), agent({})]);
    expect(main.textContent).toContain(t('overview.check.agent.ready', { label: 'Claude' }));
    expect(main.textContent).toContain(t('overview.version.check'));
    expect(main.textContent).toContain(t('overview.whatsNew.label'));
    expect(visibleEnglish(main, ALLOW)).toEqual([]);
  });

  it('problems: sentences and fix buttons are Chinese', async () => {
    const main = await mountWith([
      agent({ id: 'claude', label: 'Claude', state: 'needs_login' }),
      agent({ state: 'error', reason: 'Found it, but it did not start properly: exit code 1' }),
      agent({ id: 'cursor', label: 'Cursor Agent', state: 'unknown' as never }),
    ]);
    expect(main.textContent).toContain(t('overview.check.agent.needsLogin', { label: 'Claude' }));
    expect(main.textContent).toContain(t('overview.check.agent.didNotStartWhy', { label: 'Codex', detail: 'exit code 1' }));
    expect(main.textContent).toContain(t('overview.check.agent.notTested', { label: 'Cursor Agent' }));
    expect(visibleEnglish(host.querySelector('.st-setupcheck')!, [...ALLOW, 'Cursor', 'Agent', 'exit', 'code'])).toEqual([]);
  });

  it('the update warning sentence is Chinese', () => {
    const text = runningJobWarning(['Claude', 'Codex'], { chats: ['Claude'], terminals: ['Codex'] });
    expect(text).toContain(t('overview.update.manyAgents', { count: 2 }));
    expect(text).toContain(t('overview.update.chatsSaved', { list: 'Claude' }));
  });
});

describe('Update notice in Traditional Chinese', () => {
  const base: AppUpdateState = {
    phase: 'available', offer: { currentVersion: '1.0.0', version: '1.0.1', notes: null }, busyAgents: [], busy: { agents: [], chats: [], terminals: [] },
    percent: null, error: null, reopened: false, check: async () => undefined, update: async () => undefined, restartNow: async () => undefined,
    restartWhenIdle: () => undefined, reopenChats: async () => undefined,
  };
  it.each(['available', 'downloading', 'ready', 'waiting', 'installing', 'stopped'] as const)('phase %s has no visible English', async (phase) => {
    await act(async () => {
      root.render(<UpdateNoticeView state={{ ...base, phase, percent: phase === 'downloading' ? 40 : null, busyAgents: phase === 'ready' ? ['Claude'] : [], busy: { agents: phase === 'ready' ? ['Claude'] : [], chats: [], terminals: [] } }} />);
    });
    expect(host.textContent).not.toBe('');
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
  });
});

describe('Overview in English', () => {
  it('keeps the same words', () => {
    useEnglish();
    expect(runningJobWarning(['A'])).toBe('An agent is still working or waiting for you (A). Restarting stops it.');
  });
});
