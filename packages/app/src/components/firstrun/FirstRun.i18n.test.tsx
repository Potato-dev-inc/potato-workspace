// @vitest-environment jsdom
// The welcome in Traditional Chinese: both screens have no English left.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AgentHealth, AgentHealthApi } from '../../lib/agent-health';
import type { AgentPackApi } from '../../lib/agent-pack';
import type { AcpAddonApi } from '../../lib/acpAddon';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { FirstRun, type FirstRunDeps } from './FirstRun';
import type { Seed } from './useFirstRun';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const text = () => host.textContent ?? '';
const tapLast = async () => {
  const buttons = Array.from(host.querySelectorAll('.fr-foot button')) as HTMLButtonElement[];
  await act(async () => buttons[buttons.length - 1].click());
  await flush();
};
const tapMatching = async (re: RegExp) => {
  const el = Array.from(host.querySelectorAll('button')).find((b) => re.test(b.textContent ?? ''));
  expect(el, `a button ${re}`).toBeTruthy();
  await act(async () => el!.click());
  await flush();
};

// Exited, Needs, you, Idle: the default labels of DotSpinner (a shared component, translated with the status group).
const ALLOW = ['Exited', 'Needs', 'you', 'Idle', 'gone', 'shop', 'D', 'code', 'Cursor', 'Claude', 'Codex', 'OpenCode', 'git', 'Esc', 'Ctrl', 'K'];
const health = (id: string, label: string, over: Partial<AgentHealth> = {}): AgentHealth => ({
  id, label, state: 'unchecked', installed: true, version: '2.1.4', reason: '', install_hint: null, login_hint: null, can_test: true, ...over,
});
const healthApi: AgentHealthApi = {
  check: vi.fn(async () => [
    health('claude', 'Claude'),
    health('codex', 'Codex', { state: 'needs_login' }),
    health('cursor_agent', 'Cursor', { state: 'not_installed', installed: false, version: null }),
    health('opencode', 'OpenCode', { state: 'not_installed', installed: false, version: null }),
  ]),
  test: vi.fn(),
} as never;

const pack = {
  preview: vi.fn(), apply: vi.fn(async () => { throw new Error('x'); }), undo: vi.fn(), inspect: vi.fn(), saveCustom: vi.fn(), forgetCustom: vi.fn(), pickFile: vi.fn(), pickFolder: vi.fn(),
} as unknown as AgentPackApi;
const addons = {
  list: vi.fn(async () => ({ labsEnabled: false, addons: [] })), install: vi.fn(), remove: vi.fn(), watch: vi.fn(async () => () => undefined),
} as unknown as AcpAddonApi;

function deps(): FirstRunDeps {
  return {
    ship: {
      recent: vi.fn(async () => [
        { path: 'D:/code/shop', name: 'shop', state: 'repo', last_used_ms: 1 },
        { path: 'D:/code/gone', name: 'gone', state: 'missing', last_used_ms: 1 },
      ]),
      pickFolder: vi.fn(async () => null), forget: vi.fn(async () => undefined),
    },
    simple: { checkFolder: vi.fn(async () => ({ ok: true as const })) },
    patch: vi.fn(async () => ({}) as never),
    load: vi.fn(async () => ({}) as never),
    health: healthApi,
    pack,
    addons,
    pauseMs: 0,
    loadAgents: vi.fn(async () => null),
    handOff: vi.fn(),
    warm: { status: vi.fn(async () => null), setConfig: vi.fn(async () => null), setProject: vi.fn(async () => true), warmable: () => [] },
  } as never;
}

const cockpit = (): CockpitApi =>
  ({
    notify: vi.fn(), newAgent: vi.fn(async () => undefined), select: vi.fn(), answer: vi.fn(), prompts: {},
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    names: new Map(), now: 10_000, statusSince: new Map(), registry: { paneList: [], panes: new Map() },
  }) as unknown as CockpitApi;

async function mount(start: Seed['start']) {
  const seed: Seed = { start, look: null, project: null, agentId: null };
  await act(async () => root.render(<FirstRun c={cockpit()} seed={seed} onFinish={vi.fn()} deps={deps()} />));
  await flush();
}

describe('First run in zh-TW', () => {
  it('screen 1: agents, Set up everything and the Finish setup chip', async () => {
    await mount('agents');
    expect(text()).toContain(t('firstRun.agentsTitle'));
    expect(text()).toContain(t('firstRun.agentLogin'));
    expect(text()).toContain(t('firstRun.setUpEverything'));
    expect(text()).toContain(t('firstRun.finishSetup'));
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
    await tapMatching(new RegExp(t('firstRun.agentsMore'))); // the folded list is AgentDoctor (another owner), so only the button is checked
    expect(host.querySelector('[aria-expanded="true"]')).toBeTruthy();
  });

  it('a failed set-up step shows the shared block in Chinese', async () => {
    await mount('agents');
    await act(async () => { host.querySelector<HTMLElement>('[data-testid="set-up-everything"]')!.click(); });
    await flush();
    expect(host.querySelector('[data-testid="first-run-setup-failed"]')).toBeTruthy();
    expect(text()).toContain(t('firstRun.step.connect'));
    expect(text()).toContain(t('setupStep.fix'));
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
  });

  it('screen 2: project, with a missing folder', async () => {
    await mount('project');
    expect(text()).toContain(t('firstRun.projectTitle'));
    expect(text()).toContain(t('firstRun.hint.missing'));
    expect(text()).toContain(t('firstRun.skipStep'));
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
    await tapMatching(/shop/);
    expect(text()).toContain(t('firstRun.projectChosen'));
    expect(text()).toContain(t('firstRun.doneNow'));
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
  });

  it('the footer buttons are Chinese', async () => {
    await mount('agents');
    await tapLast();
    expect(text()).toContain(t('firstRun.projectTitle'));
    expect(visibleEnglish(host, ALLOW)).toEqual([]);
  });
});
