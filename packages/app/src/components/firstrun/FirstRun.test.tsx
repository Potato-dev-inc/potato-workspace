// @vitest-environment jsdom
// The welcome, two screens, with the backend faked. Screen 1 "Your agents": every agent found, one "Set up everything"
// button (chat add-ons, connect, keep two ready), the shared failure block with "Let <agent> fix it", sign-in kept as a
// button per agent. Screen 2: a project folder or "Skip for now", then done. Nothing is locked; "Finish setup" shows
// while something is open.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AgentHealth, AgentHealthApi } from '../../lib/agent-health';
import type { AgentPackApi } from '../../lib/agent-pack';
import type { AcpAddonApi, AddonStatus } from '../../lib/acpAddon';
import type { RecentProject } from '../../lib/ship-api';
import { FirstRun, type FirstRunDeps } from './FirstRun';
import { T } from './copy';
import type { Seed } from './useFirstRun';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const button = (text: string, exact = true) =>
  Array.from(host.querySelectorAll('button')).find((b) => (exact ? b.textContent === text : b.textContent?.includes(text))) as HTMLButtonElement | undefined;
const tap = async (text: string, exact = true) => {
  const el = button(text, exact);
  expect(el, `a button "${text}"`).toBeTruthy();
  await act(async () => el!.click());
  await flush();
};
const tapId = async (id: string) => {
  const el = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  expect(el, `[data-testid=${id}]`).toBeTruthy();
  await act(async () => el!.click());
  await flush();
};
const text = () => host.textContent ?? '';
const rows = () => Array.from(host.querySelectorAll('[data-testid="agent-rows"] li')) as HTMLElement[];
const stepStatus = (id: string) => host.querySelector(`[data-testid="first-run-setup-steps"] [data-step="${id}"]`)?.getAttribute('data-status');

const SEED: Seed = { start: 'agents', look: null, project: null, agentId: null };

const health = (over: Partial<AgentHealth> = {}): AgentHealth => ({
  id: 'claude',
  label: 'Claude',
  state: 'unchecked',
  installed: true,
  version: '2.1.4',
  reason: 'Installed.',
  install_hint: null,
  login_hint: null,
  can_test: true,
  ...over,
});

const FOUR = (over: Record<string, Partial<AgentHealth>> = {}): AgentHealth[] =>
  [
    health({ id: 'claude', label: 'Claude' }),
    health({ id: 'codex', label: 'Codex' }),
    health({ id: 'cursor_agent', label: 'Cursor', state: 'not_installed', installed: false, version: null }),
    health({ id: 'opencode', label: 'OpenCode', state: 'not_installed', installed: false, version: null }),
  ].map((r) => ({ ...r, ...(over[r.id] ?? {}) }));

const healthApi = (list: AgentHealth[]): AgentHealthApi => ({
  check: vi.fn(async () => list),
  test: vi.fn(async (id: string) => ({ ...list.find((r) => r.id === id)!, state: 'ready' as const, reason: 'Ready.' })),
});

const recent = (over: Partial<RecentProject>): RecentProject => ({ path: 'D:\\code\\shop', name: 'shop', state: 'repo', last_used_ms: 1, ...over });

const addon = (agent: string, label: string, state: AddonStatus['state'], detail = ''): AddonStatus => ({
  agent, label, state, version: null, pinned_version: null, detail, size_mb: 40, lines: [], signin_hint: '',
});

/** Chat add-ons: Claude and Codex are not installed yet; `fail` makes Claude's install fail every time. */
function fakeAddons(fail = false): AcpAddonApi {
  const state: Record<string, AddonStatus> = { claude: addon('claude', 'Claude', 'not_installed'), codex: addon('codex', 'Codex', 'not_installed') };
  return {
    list: vi.fn(async () => ({ labsEnabled: true, addons: Object.values(state) })),
    install: vi.fn(async (agent: string) => {
      state[agent] = fail && agent === 'claude' ? addon(agent, state[agent].label, 'failed', 'The download was blocked.') : addon(agent, state[agent].label, 'installed');
      return state[agent];
    }),
    remove: vi.fn(),
    watch: vi.fn(async () => () => undefined),
  } as never;
}

function fakePack(fail = false): AgentPackApi {
  return {
    preview: vi.fn(async () => ({ dry_run: true, agents: [], unsupported: [], recorded: 0 })),
    apply: vi.fn(async () => {
      if (fail) throw new Error('could not write');
      return { dry_run: false, agents: [], unsupported: [], recorded: 2 };
    }),
    undo: vi.fn(), inspect: vi.fn(), saveCustom: vi.fn(), forgetCustom: vi.fn(), pickFile: vi.fn(), pickFolder: vi.fn(),
  } as never;
}

const CHAT_VIEW = { labs_enabled: true, agents: [{ id: 'codex', label: 'Codex', lane: 'acp', effective_lane: 'acp', addon_installed: true }] } as never;

/** The warm pool, remembering what was set (so a second call sees Preload already configured). */
function fakeWarm(): FirstRunDeps['warm'] {
  let config: unknown = { preload: { enabled: false, providers: {} }, backends: {}, max_total: 3, recent_projects: 2, recent_hours: 6, idle_timeout_secs: 1200 };
  return {
    status: vi.fn(async () => ({ enabled: false, config }) as never),
    setConfig: vi.fn(async (next: unknown) => {
      config = next;
      return null;
    }),
    setProject: vi.fn(async () => true),
    warmable: () => ['claude', 'codex', 'opencode'],
  };
}

function deps(over: Partial<FirstRunDeps> = {}): FirstRunDeps & { patch: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(async () => ({}) as never);
  return {
    ship: {
      recent: vi.fn(async () => [recent({}), recent({ path: 'D:\\code\\landing', name: 'landing', state: 'folder' })]),
      pickFolder: vi.fn(async () => null),
      forget: vi.fn(async () => undefined),
    },
    simple: { checkFolder: vi.fn(async () => ({ ok: true as const })) },
    patch,
    load: vi.fn(async () => ({}) as never),
    health: healthApi(FOUR()),
    pack: fakePack(),
    addons: fakeAddons(),
    pauseMs: 0,
    loadAgents: vi.fn(async () => null),
    handOff: vi.fn(),
    warm: fakeWarm(),
    ...over,
  } as never;
}

const cockpit = () =>
  ({
    notify: vi.fn(),
    newAgent: vi.fn(async () => undefined),
    select: vi.fn(),
    answer: vi.fn(),
    prompts: {},
    asked: { questions: [], answerQuestion: vi.fn(async () => undefined), dismissQuestion: vi.fn(async () => undefined) },
    names: new Map<string, string>(),
    now: 10_000,
    statusSince: new Map<string, number>(),
    registry: { paneList: [], panes: new Map() },
  }) as unknown as CockpitApi;

async function mount(d: FirstRunDeps, seed: Seed = SEED, onFinish = vi.fn()) {
  const c = cockpit();
  await act(async () => root.render(<FirstRun c={c} seed={seed} onFinish={onFinish} deps={d} />));
  await flush();
  return { c, onFinish };
}

describe('screen 1: Your agents', () => {
  it('shows every agent found, one Set up everything button, and a Continue that is never locked', async () => {
    await mount(deps());
    expect(text()).toContain(T.agentsTitle);
    expect(rows().map((x) => x.querySelector('.fr-agentname')!.textContent)).toEqual(['Claude', 'Codex', 'Cursor', 'OpenCode']);
    expect(rows()[2].dataset.state).toBe('missing');
    expect(host.querySelectorAll('[data-testid="set-up-everything"]')).toHaveLength(1);
    expect(button(T.next)!.disabled).toBe(false);
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('code')).toBeNull(); // no command anywhere
  });

  it('nothing is set up before the button is pressed', async () => {
    const d = deps();
    await mount(d);
    expect(d.warm.setConfig).not.toHaveBeenCalled();
    expect(d.pack!.apply).not.toHaveBeenCalled();
    expect(d.addons!.install).not.toHaveBeenCalled();
  });

  it('Set up everything installs the add-ons, connects the agents and keeps Claude and Codex ready', async () => {
    const d = deps();
    await mount(d);
    await tapId('set-up-everything');
    expect(d.addons!.install).toHaveBeenCalledWith('claude');
    expect(d.addons!.install).toHaveBeenCalledWith('codex');
    expect(d.pack!.apply).toHaveBeenCalledTimes(1);
    const config = (d.warm.setConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(config.preload).toEqual({ enabled: true, providers: { claude: 1, codex: 1 } });
    for (const id of ['addons', 'connect', 'ready']) expect(stepStatus(id)).toBe('done');
    expect(host.querySelector('[data-testid="first-run-setup-done"]')!.textContent).toBe(T.setUpDone);
    expect(host.querySelector('[data-testid="set-up-everything"]')).toBeNull();
    expect(host.querySelector('[data-testid="first-run-setup-failed"]')).toBeNull();
  });

  it('a failing step is tried three times, then shows the shared block with Let <agent> fix it', async () => {
    const d = deps({ pack: fakePack(true), loadAgents: vi.fn(async () => CHAT_VIEW) });
    await mount(d);
    await tapId('set-up-everything');
    expect(d.pack!.apply).toHaveBeenCalledTimes(3);
    expect(stepStatus('addons')).toBe('done');
    expect(stepStatus('connect')).toBe('failed');
    expect(stepStatus('ready')).toBe('waiting');
    expect(host.querySelector('[data-testid="first-run-setup-failed"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="first-run-setup-fix"]')!.textContent).toBe('Let Codex fix it');
    // The raw error is folded under Details, never on the face.
    expect(host.querySelector('[data-testid="first-run-setup-failed"] .ss-fail-line')!.textContent).not.toContain('could not write');
    // The welcome can still be left.
    expect(button(T.next)!.disabled).toBe(false);
  });

  it('Let <agent> fix it opens a chat with the goal and the error, and pauses the welcome', async () => {
    const d = deps({ pack: fakePack(true), loadAgents: vi.fn(async () => CHAT_VIEW) });
    await mount(d);
    await tapId('set-up-everything');
    await tapId('first-run-setup-fix');
    const call = (d.handOff as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('chat');
    expect(call[1]).toBe('codex');
    expect(call[2]).toContain('could not write');
    expect(host.querySelector('.fr-bar')).toBeTruthy();
  });

  it('a failure with no agent that can chat says so instead of failing silently', async () => {
    await mount(deps({ addons: fakeAddons(true) }));
    await tapId('set-up-everything');
    expect(stepStatus('addons')).toBe('failed');
    await tapId('first-run-setup-fix');
    expect(host.querySelector('[data-testid="first-run-setup-handed"]')!.textContent).toBe(T.noAgentToFix);
  });

  it('an agent that needs a sign-in keeps a Sign in button, which pauses the welcome', async () => {
    const d = deps({ health: healthApi(FOUR({ claude: { state: 'needs_login' }, codex: { state: 'not_installed', installed: false } })) });
    const { c } = await mount(d);
    expect(rows()[0].dataset.state).toBe('login');
    // With no usable agent, the set-up button waits and the line says why.
    expect(text()).toContain(T.agentsNone);
    expect((host.querySelector('[data-testid="set-up-everything"]') as HTMLButtonElement).disabled).toBe(true);
    expect(button(T.next)!.disabled).toBe(false);
    await tap(T.agentSignIn);
    expect(c.newAgent).toHaveBeenCalledWith('claude');
    expect(host.querySelector('.fr-bar')!.textContent).toContain(T.pausedBar);
    await tap(T.pausedButton);
    expect((host.querySelector('.fr-shell') as HTMLElement).hidden).toBe(false);
  });

  it('shows a Finish setup chip while something is not done, and Esc leaves reporting it pending', async () => {
    const { onFinish } = await mount(deps());
    expect(host.querySelector('[data-testid="finish-setup-chip"]')!.textContent).toBe(T.finishSetup);
    await act(async () => {
      host.querySelector('.fr-shell')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onFinish).toHaveBeenCalledWith(true);
  });

  it('writes nothing until something changes, then saves the step', async () => {
    const d = deps();
    await mount(d);
    d.patch.mockClear();
    await tap(T.next);
    expect(d.patch).toHaveBeenCalledWith({ onboarding_step: 'project' });
  });
});

describe('screen 2: your project', () => {
  const projectSeed: Seed = { ...SEED, start: 'project' };

  it('lists Recent, and any folder can be picked (Git is not asked for)', async () => {
    const d = deps();
    await mount(d, projectSeed);
    expect(text()).toContain(T.projectTitle);
    await tap('landing', false);
    expect(host.querySelector('[data-testid="picked-project"]')!.textContent).toContain('landing');
    expect(host.querySelector('[data-testid="git-step"]')).toBeNull();
    expect(host.querySelector('code')).toBeNull();
    expect(d.patch).toHaveBeenCalledWith({ onboarding_project: 'D:\\code\\landing' });
  });

  it('Skip for now finishes with set-up reported as pending', async () => {
    const { onFinish } = await mount(deps(), projectSeed);
    expect(button(T.skipStep)).toBeTruthy();
    await tap(T.skipStep);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(true);
  });

  it('a picked folder turns the button into Done; after Set up everything nothing is pending', async () => {
    const d = deps();
    const onFinish = vi.fn();
    await mount(d, SEED, onFinish);
    await tapId('set-up-everything');
    await tapId('first-run-next');
    expect(host.querySelector('[data-testid="finish-setup-chip"]')).not.toBeNull(); // no folder yet
    await tap('shop', false);
    expect(host.querySelector('[data-testid="finish-setup-chip"]')).toBeNull();
    expect(d.warm.setProject).toHaveBeenCalledWith('D:\\code\\shop');
    await tap(T.doneNow);
    expect(onFinish).toHaveBeenCalledWith(false);
  });

  it('Back returns to the agents', async () => {
    await mount(deps(), projectSeed);
    await tap(T.back);
    expect(text()).toContain(T.agentsTitle);
  });
});

describe('the welcome is a real modal', () => {
  /** A page the welcome sits on: a cockpit with a button, and the welcome beside it, as in the app. */
  async function mountOnPage(d: FirstRunDeps, seed: Seed = SEED, onFinish = vi.fn()) {
    const render = () =>
      root.render(
        <>
          <button type="button" id="behind">Behind the welcome</button>
          <FirstRun c={cockpit()} seed={seed} onFinish={onFinish} deps={d} />
        </>,
      );
    await act(async () => render());
    await flush();
    return { onFinish };
  }
  const key = (k: string, shift = false) =>
    act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
    });

  it('names itself a modal dialog and puts focus inside it', async () => {
    await mountOnPage(deps());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe(T.title);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('makes the cockpit behind it inert and hidden from screen readers', async () => {
    await mountOnPage(deps());
    const behind = host.querySelector('#behind')!;
    expect(behind.hasAttribute('inert')).toBe(true);
    expect(behind.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[data-testid="first-run"]')!.hasAttribute('inert')).toBe(false);
  });

  it('Tab and Shift+Tab wrap inside the welcome and never reach what is behind', async () => {
    await mountOnPage(deps());
    const layer = host.querySelector('[data-testid="first-run"]')!;
    const stops = Array.from(layer.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, summary')).filter((el) => el.tabIndex >= 0);
    expect(stops.length).toBeGreaterThan(1);
    stops[stops.length - 1].focus();
    await key('Tab');
    expect(document.activeElement).toBe(stops[0]);
    await key('Tab', true);
    expect(document.activeElement).toBe(stops[stops.length - 1]);
    for (let i = 0; i < stops.length + 2; i += 1) {
      await key('Tab');
      expect(layer.contains(document.activeElement)).toBe(true);
    }
  });

  it('focus that lands outside is pulled back in', async () => {
    await mountOnPage(deps());
    const behind = host.querySelector<HTMLElement>('#behind')!;
    await act(async () => behind.focus());
    expect(host.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  });

  it('Esc leaves the welcome once; Esc in a text box does not', async () => {
    const { onFinish } = await mountOnPage(deps());
    const input = document.createElement('input');
    host.querySelector('.fr-body')!.appendChild(input);
    input.focus();
    await key('Escape');
    expect(onFinish).not.toHaveBeenCalled();
    input.remove();
    host.querySelector<HTMLElement>('.fr-shell')!.focus();
    await key('Escape');
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('Esc closes an open fold-away first', async () => {
    const { onFinish } = await mountOnPage(deps());
    await tap(T.agentsMore);
    const more = button(T.agentsMore)!;
    more.focus();
    await key('Escape');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('while paused as a bar the cockpit is reachable again, and focus returns when the welcome closes', async () => {
    const d = deps({ health: healthApi(FOUR({ claude: { state: 'needs_login' } })) });
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    await mountOnPage(d);
    await tap(T.agentSignIn);
    expect(host.querySelector('#behind')!.hasAttribute('inert')).toBe(false);
    await tap(T.pausedButton);
    expect(host.querySelector('#behind')!.hasAttribute('inert')).toBe(true);
    await act(async () => root.render(<button type="button" id="behind">Behind the welcome</button>));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
