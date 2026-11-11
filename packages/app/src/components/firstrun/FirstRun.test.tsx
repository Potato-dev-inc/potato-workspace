// @vitest-environment jsdom
// The welcome, step by step, with the backend faked: agents found by themselves, the one-button
// connection with its file list and Undo, the folder guard, the demo with its nested helper, the links
// to Phone and Agent pack on the last screen, and the timing record. One test walks all four steps.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AgentHealth, AgentHealthApi } from '../../lib/agent-health';
import type { AgentPackApi, PackAgent, PackReport } from '../../lib/agent-pack';
import type { RecentProject } from '../../lib/ship-api';
import { FirstRun, type FirstRunDeps } from './FirstRun';
import { demoPrompt, T, TASK_PROMPT } from './copy';
import { TIMING_KEY, readTiming } from './timing';
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

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const button = (text: string, exact = true) =>
  Array.from(host.querySelectorAll('button')).find((b) => (exact ? b.textContent === text : b.textContent?.includes(text))) as HTMLButtonElement | undefined;
const tap = async (text: string, exact = true) => {
  const el = button(text, exact);
  expect(el, `a button "${text}"`).toBeTruthy();
  await act(async () => el!.click());
  await flush();
};
const text = () => host.textContent ?? '';
const rows = () => Array.from(host.querySelectorAll('[data-testid="agent-rows"] li')) as HTMLElement[];

const SEED: Seed = { start: 'agents', look: null, project: null, agentId: null };

const health = (over: Partial<AgentHealth> = {}): AgentHealth => ({
  id: 'claude',
  label: 'Claude',
  state: 'unchecked',
  installed: true,
  version: '2.1.4',
  reason: 'Installed. Press Test to check it can answer.',
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

// ---- the agent pack, faked: a plan that changes two files, then "already there" ----
const packAgent = (id: string, label: string, done: boolean): PackAgent => ({
  id,
  label,
  installed: true,
  skills: {
    status: done ? 'unchanged' : 'ready',
    path: `C:/Users/a/.${id}/skills`,
    shared_with: [],
    files: [{ name: 'delegate', kind: done ? 'unchanged' : 'add' }],
    reason: null,
    written: false,
  },
  mcp: {
    status: done ? 'unchanged' : 'ready',
    path: `C:/Users/a/.${id}/config.json`,
    format: 'json',
    shared_with: [],
    change: done ? 'unchanged' : 'add',
    reason: null,
    diff: '',
    written: false,
    backup: null,
  },
});

function fakePack(startDone = false): AgentPackApi & { state: { done: boolean } } {
  const state = { done: startDone };
  const report = (): PackReport => ({
    dry_run: true,
    agents: [packAgent('claude', 'Claude Code', state.done), packAgent('codex', 'Codex', state.done)],
    unsupported: [],
    recorded: state.done && !startDone ? 2 : 0,
  });
  return {
    state,
    preview: vi.fn(async () => report()),
    apply: vi.fn(async () => {
      state.done = true;
      return report();
    }),
    undo: vi.fn(async () => {
      state.done = false;
      return { restored: ['a'], removed: [], skipped: [], recorded: 0 };
    }),
    inspect: vi.fn(),
    saveCustom: vi.fn(),
    forgetCustom: vi.fn(),
    pickFile: vi.fn(),
    pickFolder: vi.fn(),
  } as never;
}

function deps(over: Partial<FirstRunDeps> = {}): FirstRunDeps & { patch: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(async () => ({}) as never);
  return {
    ship: {
      recent: vi.fn(async () => [recent({})]),
      pickFolder: vi.fn(async () => null),
      forget: vi.fn(async () => undefined),
      gitInitPlan: vi.fn(async (path: string) => ({ path, name: 'x', state: 'folder' as const, commands: ['git init', 'git add -A'], files: 12, too_big: false, gitignore: [] })),
      gitInit: vi.fn(async () => ({ commit: 'abc', files: 12, wrote_gitignore: true })),
    },
    simple: { checkFolder: vi.fn(async () => ({ ok: true as const })) },
    patch,
    load: vi.fn(async () => ({}) as never),
    health: healthApi(FOUR()),
    pack: fakePack(),
    demo: { start: vi.fn(async () => ({ paneId: 'pane-main', warm: true, mcp: true })) },
    warm: {
      status: vi.fn(async () => ({ config: { preload: { enabled: false, providers: {} }, enabled: false, backends: {}, max_total: 3, recent_projects: 2, recent_hours: 6, idle_timeout_secs: 1200 } }) as never),
      setConfig: vi.fn(async () => null),
      setProject: vi.fn(async () => true),
      warmable: () => ['claude', 'codex', 'opencode'],
    },
    ...over,
  } as never;
}

type PaneSpec = { id: string; status: string; parent?: string; type?: string };
const cockpit = (panes: PaneSpec[] = [], over: Record<string, unknown> = {}) => {
  const list = panes.map((p) => ({ info: { id: p.id, agent_type: p.type ?? 'claude', parent_pane_id: p.parent ?? null, created_at: 1, title: null }, status: p.status }));
  return {
    notify: vi.fn(),
    newAgent: vi.fn(async () => undefined),
    select: vi.fn(),
    answer: vi.fn(),
    prompts: {},
    asked: { questions: [], answerQuestion: vi.fn(async () => undefined), dismissQuestion: vi.fn(async () => undefined) },
    names: new Map<string, string>(),
    now: 10_000,
    statusSince: new Map<string, number>(),
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])) },
    ...over,
  } as unknown as CockpitApi;
};

async function mount(d: FirstRunDeps, seed: Seed = SEED, c: CockpitApi = cockpit(), onFinish = vi.fn()) {
  const render = (next: CockpitApi) => root.render(<FirstRun c={next} seed={seed} onFinish={onFinish} deps={d} />);
  await act(async () => render(c));
  await flush();
  const update = async (next: CockpitApi) => {
    await act(async () => render(next));
    await flush();
  };
  return { c, onFinish, update };
}

describe('1. Your agents', () => {
  it('finds the four agents by itself: a tick for each one that is there, Install for the rest', async () => {
    await mount(deps());
    expect(text()).toContain(T.agentsTitle);
    const r = rows();
    expect(r.map((x) => x.querySelector('.fr-agentname')!.textContent)).toEqual(['Claude', 'Codex', 'Cursor', 'OpenCode']);
    expect(r[0].dataset.state).toBe('ready');
    expect(r[0].textContent).toContain(T.agentFound);
    expect(r[1].dataset.state).toBe('ready');
    expect(r[2].dataset.state).toBe('missing');
    expect(Array.from(r[2].querySelectorAll('button')).map((b) => b.textContent)).toEqual([T.agentInstall]);
    expect(text()).toContain(T.agentsReady(2));
    expect(button('Continue')!.disabled).toBe(false);
    expect(host.querySelector('input')).toBeNull(); // nothing to type
  });

  it('an agent that needs a sign-in says so and offers Sign in, which pauses the welcome', async () => {
    const d = deps({ health: healthApi(FOUR({ claude: { state: 'needs_login' }, codex: { state: 'not_installed', installed: false } })) });
    const { c } = await mount(d);
    expect(rows()[0].dataset.state).toBe('login');
    expect(text()).toContain(T.agentsNone);
    expect(button('Continue')!.disabled).toBe(true);
    await tap(T.agentSignIn);
    expect(c.newAgent).toHaveBeenCalledWith('claude');
    expect(host.querySelector('.fr-bar')!.textContent).toContain(T.pausedBar);
    expect((host.querySelector('.fr-shell') as HTMLElement).hidden).toBe(true);
    await tap(T.pausedButton);
    expect((host.querySelector('.fr-shell') as HTMLElement).hidden).toBe(false);
  });

  it('the first screen no longer asks how you work: that moved to the last screen', async () => {
    await mount(deps());
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(text()).not.toContain(T.howDoYouWork);
  });

  it('starts warming Claude and Codex in the most recent repository while the person reads', async () => {
    const d = deps();
    await mount(d);
    expect(d.warm.setConfig).toHaveBeenCalledTimes(1);
    const config = (d.warm.setConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(config.preload).toEqual({ enabled: true, providers: { claude: 1, codex: 1 } });
    expect(d.warm.setProject).toHaveBeenCalledWith('D:\\code\\shop');
    // The note is folded behind "Help with an agent".
    expect(host.querySelector('[data-testid="warming-note"]')).toBeNull();
    await tap(T.agentsMore);
    expect(host.querySelector('[data-testid="warming-note"]')!.textContent).toBe(T.agentsWarm);
  });

  it('leaves a Preload setup the person made alone, and only tells the pool the folder', async () => {
    const d = deps();
    d.warm.status = vi.fn(async () => ({ config: { preload: { enabled: true, providers: { claude: 2 } } } }) as never);
    await mount(d);
    expect(d.warm.setConfig).not.toHaveBeenCalled();
    expect(d.warm.setProject).toHaveBeenCalledWith('D:\\code\\shop');
    expect(host.querySelector('[data-testid="warming-note"]')).toBeNull();
  });

  it('can be skipped, and a skip at the top of the welcome finishes once', async () => {
    const d = deps({ health: healthApi(FOUR({ claude: { state: 'not_installed', installed: false }, codex: { state: 'not_installed', installed: false } })) });
    const { onFinish } = await mount(d);
    expect(d.warm.setConfig).not.toHaveBeenCalled(); // nothing to warm
    expect(text()).not.toContain('Skip setup'); // one skip control, not two
    await tap(T.skipStep);
    expect(text()).toContain(T.connectTitle);
    await act(async () => {
      host.querySelector('.fr-shell')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('writes nothing until something changes, then saves the step', async () => {
    const d = deps();
    await mount(d);
    d.patch.mockClear();
    await tap('Continue');
    expect(d.patch).toHaveBeenCalledWith({ onboarding_step: 'connect' });
  });
});

describe('2. Connect your agents', () => {
  const at: Seed = { ...SEED, start: 'connect' };

  it('lists the files that change, one button adds Potato Workspace, Undo puts it back', async () => {
    const d = deps();
    await mount(d, at);
    const files = host.querySelector('[data-testid="connect-files"]')!.textContent!;
    expect(files).toContain('C:/Users/a/.claude/config.json');
    expect(files).toContain('C:/Users/a/.codex/config.json');
    expect(button('Continue')!.disabled).toBe(true);
    await tap(T.connectButton(['Claude Code', 'Codex']));
    expect(d.pack!.apply).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="connect-done"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connect-files"]')).toBeNull();
    expect(button('Continue')!.disabled).toBe(false);
    await tap(T.connectUndo);
    expect(d.pack!.undo).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="connect-message"]')!.textContent).toBe(T.connectUndone);
    expect(host.querySelector('[data-testid="connect-files"]')).not.toBeNull();
    expect(button('Continue')!.disabled).toBe(true);
  });

  it('already connected: a tick, no button, and Continue is on at once', async () => {
    const d = deps({ pack: fakePack(true) });
    await mount(d, at);
    expect(host.querySelector('[data-testid="connect-done"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connect-files"]')).toBeNull();
    expect(button(T.connectButton(['Claude Code']), false)).toBeUndefined();
    expect(button('Continue')!.disabled).toBe(false);
  });

  it('a failed install says so and leaves Continue off', async () => {
    const pack = fakePack();
    pack.apply = vi.fn(async () => {
      throw new Error('disk full');
    });
    await mount(deps({ pack }), at);
    await tap(T.connectButton(['Claude Code', 'Codex']));
    expect(host.querySelector('[data-testid="connect-message"]')!.textContent).toContain(T.connectFailed);
    expect(button('Continue')!.disabled).toBe(true);
  });

  it('can be skipped', async () => {
    await mount(deps(), at);
    await tap(T.skipStep);
    expect(text()).toContain(T.projectTitle);
  });
});

describe('3. Your first project', () => {
  const at: Seed = { ...SEED, start: 'project', look: 'code' };

  it('lists Recent, and a repository can be chosen', async () => {
    const d = deps();
    await mount(d, at);
    expect(text()).toContain('shop');
    expect(button('Continue')!.disabled).toBe(true);
    await tap('shop', false);
    expect(host.querySelector('[data-testid="picked-project"]')!.textContent).toContain(T.projectChosen);
    expect(button('Continue')!.disabled).toBe(false);
  });

  it('refuses a broad folder: the row says so, and a picked one is not accepted', async () => {
    const documents = recent({ path: 'C:\\Users\\Ana\\Documents', name: 'Documents', state: 'folder' });
    const d = deps({
      ship: { ...deps().ship, recent: vi.fn(async () => [documents]), pickFolder: vi.fn(async () => documents) },
      simple: { checkFolder: vi.fn(async () => ({ ok: false as const, code: 'FOLDER_TOO_BROAD', message: 'documents' })) },
    });
    await mount(d, at);
    const row = host.querySelector('.fr-row') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    await tap(T.chooseFolder);
    expect(host.querySelector('.fr-problem')!.textContent).toBe(T.tooBroad);
    expect(host.querySelector('[data-testid="picked-project"]')).toBeNull();
    expect(button('Continue')!.disabled).toBe(true);
    expect(d.simple.checkFolder).toHaveBeenCalledWith('C:\\Users\\Ana\\Documents');
  });

  it('a folder without Git shows the commands first; Set up Git here makes it ready', async () => {
    const plain = recent({ path: 'D:\\code\\page', name: 'page', state: 'folder' });
    const d = deps({ ship: { ...deps().ship, recent: vi.fn(async () => [plain]), gitInitPlan: deps().ship.gitInitPlan, gitInit: vi.fn(async () => ({ commit: 'a', files: 12, wrote_gitignore: true })) } });
    await mount(d, at);
    await tap('page', false);
    const step = host.querySelector('[data-testid="git-step"]')!;
    expect(step.textContent).toContain(T.needsGitTitle);
    expect(step.textContent).toContain('git init');
    expect(button('Continue')!.disabled).toBe(true);
    await tap(T.setUpGit);
    expect(d.ship.gitInit).toHaveBeenCalledWith('D:\\code\\page');
    expect(host.querySelector('[data-testid="git-step"]')).toBeNull();
    expect(button('Continue')!.disabled).toBe(false);
  });

  it('choosing the folder tells the warm pool where to warm', async () => {
    const d = deps();
    await mount(d, { ...at, agentId: 'claude' });
    (d.warm.setProject as ReturnType<typeof vi.fn>).mockClear();
    await tap('shop', false);
    expect(d.warm.setProject).toHaveBeenCalledWith('D:\\code\\shop');
  });
});

describe('4. Try it', () => {
  const project = { path: 'D:/code/shop', name: 'shop', state: 'repo' as const };
  const at: Seed = { start: 'task', look: 'code', project, agentId: 'claude' };
  it('with only Claude ready the demo is the single-agent question, and says so', async () => {
    const d = deps();
    await mount(d, at);
    expect(host.querySelector('[data-testid="task-prompt"]')!.textContent).toBe(TASK_PROMPT);
    expect(host.querySelector('[data-testid="task-solo"]')!.textContent).toBe(T.taskSolo);
    expect(d.demo.start).not.toHaveBeenCalled();
    expect(button('Continue')!.disabled).toBe(true);
  });

  it('with no ready agent or no folder it says what is missing and goes back', async () => {
    await mount(deps(), { ...at, agentId: null });
    expect(text()).toContain(T.taskNeedsAgent);
    await tap(T.stepNames.agents);
    expect(text()).toContain(T.agentsTitle);
  });

  it('a refused start says so and can be tried again', async () => {
    const d = deps({ demo: { start: vi.fn(async () => null) } });
    await mount(d, at);
    await tap(T.taskStart('Claude'));
    expect(host.querySelector('.fr-problem')!.textContent).toBe(T.taskPaneFailed);
    expect(button(T.taskStart('Claude'))).toBeTruthy();
  });

  it('can be skipped, and the welcome goes on to the last screen', async () => {
    await mount(deps(), at);
    await tap(T.skipStep);
    expect(text()).toContain(T.doneTitle);
  });
});

describe('the whole welcome, four steps', () => {
  it('walks agents, connect, project and try it, nests the helper under Claude, records the time, then ends', async () => {
    const d = deps();
    const onFinish = vi.fn();
    // The welcome starts its clock when it mounts, so the bound below starts before the mount, not after it.
    const t0 = Date.now();
    const m = await mount(d, SEED, cockpit(), onFinish);

    // 1. Agents: found without typing; Claude and Codex are both ready.
    expect(text()).toContain(T.agentsReady(2));
    expect(readTiming()).not.toBeNull(); // the clock started
    await tap('Continue');

    // 2. Connect: one button.
    expect(text()).toContain(T.connectTitle);
    await tap(T.connectButton(['Claude Code', 'Codex']));
    expect(d.pack!.apply).toHaveBeenCalledTimes(1);
    await tap('Continue');

    // 3. Project: pick the recent repository.
    expect(text()).toContain(T.projectTitle);
    await tap('shop', false);
    await tap('Continue');

    // 4. Try it: Claude is the main agent, Codex the helper it is told to ask.
    expect(text()).toContain(T.taskTitle);
    expect(host.querySelector('[data-testid="task-prompt"]')!.textContent).toBe(demoPrompt('Codex'));
    expect(host.querySelector('[data-testid="task-prompt"]')!.textContent).toBe('Use the potato-workspace run_agent tool to have Codex review the last commit in this project and list 3 risks. Tell Codex not to change any files. Show me its answer.');
    expect(button('Continue')!.disabled).toBe(true);
    await tap(T.taskStart('Claude'));
    expect(d.demo.start).toHaveBeenCalledWith(expect.anything(), 'claude', 'D:\\code\\shop', demoPrompt('Codex'), true);

    // It says which way the agent started.
    expect(host.querySelector('[data-testid="task-warm"]')!.textContent).toBe(T.taskWarm);

    // Claude works.
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }]));
    expect(text()).toContain(T.taskWorking('Claude'));
    expect(button('Continue')!.disabled).toBe(true);

    // The helper pane appears nested under it, working.
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }, { id: 'pane-helper', status: 'running', parent: 'pane-main', type: 'codex' }]));
    const helpers = host.querySelector('[data-testid="task-helpers"]')!;
    expect(helpers.textContent).toContain('codex');
    expect(helpers.textContent).toContain('working');
    expect(button('Continue')!.disabled).toBe(true);

    // The helper finishes, Claude is back at its prompt: the first result.
    await m.update(cockpit([{ id: 'pane-main', status: 'idle' }, { id: 'pane-helper', status: 'idle', parent: 'pane-main', type: 'codex' }]));
    expect(host.querySelector('[data-testid="task-done"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="task-helpers"]')!.textContent).toContain('done');
    expect(button('Continue')!.disabled).toBe(false);

    // The time to the first result is saved locally.
    const timing = readTiming()!;
    expect(timing.firstResultMs).toBeGreaterThanOrEqual(0);
    expect(timing.firstResultMs).toBeLessThanOrEqual(Date.now() - t0 + 5);
    expect(JSON.parse(window.localStorage.getItem(TIMING_KEY)!).firstResultMs).toBe(timing.firstResultMs);
    expect(host.querySelector('[data-testid="task-time"]')).not.toBeNull();

    // Done: the saved steps went by in order.
    await tap('Continue');
    expect(text()).toContain(T.doneTitle);
    expect(d.patch.mock.calls.map((x) => (x[0] as { onboarding_step?: string }).onboarding_step).filter(Boolean)).toEqual(['connect', 'project', 'task', 'done']);
    expect(onFinish).not.toHaveBeenCalled();
    await tap(T.doneButton);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('an approval card the demo agent raises shows inline, and the demo is not finished while it waits', async () => {
    const d = deps();
    const m = await mount(d, { start: 'task', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: 'claude' });
    await tap(T.taskStart('Claude'));
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }]));
    const prompts = {
      'pane-main': {
        promptId: 'p1',
        kind: 'approval',
        text: 'Run the Potato Workspace tool?',
        choices: [{ id: '1', label: 'Yes' }, { id: '3', label: 'No' }],
        risk: { level: 'low', headline: 'Use a tool', reasons: ['It asks another agent.'] },
      },
    };
    await m.update(cockpit([{ id: 'pane-main', status: 'waiting_input' }], { prompts }));
    expect(text()).toContain('Use a tool');
    expect(text()).toContain(T.approvalTip);
    expect(text()).toContain(T.taskAsking('Claude'));
    expect(host.querySelector('[data-testid="task-done"]')).toBeNull();
  });

  it('a second agent that never starts a helper does not trap the person: skip works and Done follows', async () => {
    const d = deps();
    const m = await mount(d, { start: 'task', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: 'claude' });
    await tap(T.taskStart('Claude'));
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }]));
    await tap(T.skipStep);
    expect(text()).toContain(T.doneTitle);
  });
});

describe('Done: more you can set up', () => {
  it('shows a cold start as cold', async () => {
    const d = deps({ demo: { start: vi.fn(async () => ({ paneId: 'pane-main', warm: false, mcp: true })) } });
    await mount(d, { start: 'task', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: 'claude' });
    await tap(T.taskStart('Claude'));
    expect(host.querySelector('[data-testid="task-warm"]')!.textContent).toBe(T.taskCold);
  });

  it('waits for a warm worker that is starting in the chosen folder before it sends', async () => {
    const d = deps();
    const base = await d.warm.status();
    const standbys = (state: string, project: string) => ({ ...(base as object), standbys: [{ agent_type: 'claude', project, headless: false, state }] });
    let n = 0;
    d.warm.status = vi.fn(async () => (++n === 1 ? base : n === 2 ? standbys('starting', 'D:/code/shop') : standbys('ready', 'd:/code/shop/'))) as never;
    await mount(d, { start: 'task', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: 'claude' });
    await tap(T.taskStart('Claude'));
    expect(d.demo.start).not.toHaveBeenCalled(); // still waiting for the warm worker
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    await flush();
    expect((d.warm.status as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3); // mount, then the wait sees starting, then ready
    expect(d.demo.start).toHaveBeenCalledTimes(1);
  });

  it('shows Agent pack as done when step 2 already added it', async () => {
    const d = deps();
    await mount(d, { ...SEED, start: 'connect' });
    await tap(T.connectButton(['Claude Code', 'Codex']));
    await tap('Continue');
    await tap(T.skipStep);
    await tap(T.skipStep);
    const links = host.querySelector('[data-testid="more-links"]')!;
    expect(links.textContent).toContain(T.morePackDone);
    expect(links.querySelectorAll('button')).toHaveLength(1);
  });

  const atDone: Seed = { ...SEED, start: 'done', look: 'code' };

  it('asks how you work here: radios named by their label and described by their hint', async () => {
    const d = deps();
    await mount(d, { ...atDone, look: null });
    const radios = Array.from(host.querySelectorAll('[role="radio"]')) as HTMLElement[];
    expect(radios).toHaveLength(3);
    for (const [i, id] of (['code', 'ai', 'none'] as const).entries()) {
      expect(radios[i].querySelector('.fr-lookname')!.textContent).toBe(T.looks[id].label);
      const hint = host.querySelector(`#${radios[i].getAttribute('aria-describedby')}`)!;
      expect(hint.textContent).toBe(T.looks[id].hint);
      expect(radios[i].getAttribute('title')).toBeNull();
    }
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1); // one tab stop for the group
    await tap('I write code', false);
    expect(d.patch).toHaveBeenCalledWith({ simple_mode: false });
    expect(host.querySelector('[data-testid="look-note"]')!.textContent).toBe(T.noteCode);
    await tap("I don't code", false);
    expect(d.patch).toHaveBeenCalledWith({ simple_mode: true });
    expect(host.querySelector('[data-testid="look-note"]')!.textContent).toContain('Simple mode is on');
  });

  it('arrow keys move between the radios', async () => {
    const d = deps();
    await mount(d, { ...atDone, look: 'code' });
    const radios = Array.from(host.querySelectorAll('[role="radio"]')) as HTMLElement[];
    radios[0].focus();
    await act(async () => {
      radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
  });

  it('has three tips and links to Phone and Agent pack, which are not on the main path', async () => {
    const d = deps();
    await mount(d, atDone);
    expect(host.querySelectorAll('.fr-tipr')).toHaveLength(3);
    expect(text()).toContain(T.moreTitle);
    const links = host.querySelector('[data-testid="more-links"]')!;
    expect(links.textContent).toContain(T.morePhone);
    expect(links.textContent).toContain(T.morePack);
  });

  it('Phone opens its screen and Back returns to the end; the welcome is not finished', async () => {
    const d = deps();
    const { onFinish } = await mount(d, atDone);
    const setUp = Array.from(host.querySelectorAll('[data-testid="more-links"] button')) as HTMLButtonElement[];
    await act(async () => setUp[0].click());
    await flush();
    expect(text()).toContain(T.phoneTitle);
    await tap(T.back);
    expect(text()).toContain(T.doneTitle);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('Agent pack opens its screen with the review button', async () => {
    const d = deps();
    await mount(d, atDone);
    const setUp = Array.from(host.querySelectorAll('[data-testid="more-links"] button')) as HTMLButtonElement[];
    await act(async () => setUp[1].click());
    await flush();
    expect(text()).toContain(T.packTitle);
    expect(host.querySelector('[data-testid="pack-found"]')!.textContent).toContain('Claude Code');
    expect(button(T.packReview)).toBeTruthy();
  });

  it('the old saved steps land here: phone and pack resume at the end, welcome at the agents', async () => {
    const { resumeStep } = await import('./model');
    expect(resumeStep('phone', false)).toBe('done');
    expect(resumeStep('pack', true)).toBe('done');
    expect(resumeStep('welcome', false)).toBe('agents');
  });
});

describe('found in a live run', () => {
  it('step 3 lets a too-big folder through and hides a subfolder of a listed repository', async () => {
    const root = recent({ path: 'D:/pm-workspace', name: 'pm-workspace' });
    const nested = recent({ path: 'D:/pm-workspace/packages/app/src-tauri', name: 'src-tauri' });
    const d = deps({
      ship: { ...deps().ship, recent: vi.fn(async () => [nested, root]) },
      simple: { checkFolder: vi.fn(async () => ({ ok: false as const, code: 'FOLDER_TOO_BIG', message: 'big' })) },
    });
    await mount(d, { ...SEED, start: 'project' });
    expect(Array.from(host.querySelectorAll('.fr-row')).map((r) => r.querySelector('.fr-row-name')!.textContent)).toEqual(['pm-workspace']);
    expect((host.querySelector('.fr-row') as HTMLButtonElement).disabled).toBe(false);
    await tap('pm-workspace', false);
    expect(host.querySelector('[data-testid="picked-project"]')).not.toBeNull();
    expect(button('Continue')!.disabled).toBe(false);
  });

  it('step 1 counts the four rows it shows, not an extra hidden agent', async () => {
    const extra = health({ id: 'opencode_native', label: 'OpenCode (API)' });
    await mount(deps({ health: healthApi([...FOUR(), extra]) }));
    expect(rows()).toHaveLength(4);
    expect(text()).toContain(T.agentsReady(2));
  });
});

describe('connect: what changes, and the dev build warning', () => {
  it('names where an entry pointed before, and warns in a dev build', async () => {
    const pack = fakePack();
    const base = await pack.preview();
    const agents = base.agents.map((a) => (a.id === 'codex' ? { ...a, mcp: { ...a.mcp!, change: 'update' as const, diff: '- command = "C:/old/mcp.exe"\n+ command = "C:/new/mcp.exe"' } } : a));
    pack.preview = vi.fn(async () => ({ ...base, agents })) as never;
    await mount(deps({ pack }), { ...SEED, start: 'connect' });
    const files = host.querySelector('[data-testid="connect-files"]')!.textContent!;
    expect(files).toContain(T.connectPointsTo('C:/old/mcp.exe'));
    expect(files).not.toContain(T.connectFileFix);
    // vitest runs with import.meta.env.DEV on, like the dev app.
    expect(host.querySelector('[data-testid="connect-dev"]')!.textContent).toBe(T.connectDevWarn);
  });
});

describe('the demo must really use Potato Workspace', () => {
  const at: Seed = { start: 'agents', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: null };
  const toTry = async (d: FirstRunDeps) => {
    const m = await mount(d, at);
    await tap('Continue');
    await tap(T.connectButton(['Claude Code', 'Codex']));
    await tap('Continue');
    await tap('Continue');
    return m;
  };

  it('uses the short agent name in the prompt, not Codex CLI', async () => {
    const d = deps({ health: healthApi(FOUR({ codex: { label: 'Codex CLI' } })) });
    await toTry(d);
    expect(host.querySelector('[data-testid="task-prompt"]')!.textContent).toBe(demoPrompt('Codex'));
    expect(text()).not.toContain('Codex CLI');
  });

  it('says so plainly and sends nothing when the agent cannot reach this app', async () => {
    const d = deps({ demo: { start: vi.fn(async () => ({ paneId: 'pane-main', warm: true, mcp: false })) } });
    await toTry(d);
    await tap(T.taskStart('Claude'));
    const box = host.querySelector('[data-testid="task-no-mcp"]')!;
    expect(box.textContent).toContain(T.taskNoMcp('Claude'));
    expect(box.textContent).toContain(T.taskNoMcpHow);
    expect(host.querySelector('[data-testid="task-helpers"]')).toBeNull();
    expect(button('Continue')!.disabled).toBe(true);
  });

  it('with no helper started it does not say it worked: it says Claude answered alone and offers Try again', async () => {
    const d = deps();
    const m = await toTry(d);
    await tap(T.taskStart('Claude'));
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }]));
    // Claude stops with no helper, and has been quiet for longer than the grace time.
    await m.update(cockpit([{ id: 'pane-main', status: 'idle' }], { now: 100_000, statusSince: new Map([['pane-main', 10_000]]) }));
    expect(host.querySelector('[data-testid="task-done"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-alone"]')!.textContent).toContain(T.taskAlone);
    expect(readTiming()?.firstResultMs).toBeUndefined();
    expect(button('Continue')!.disabled).toBe(true);
    await tap(T.taskAgain);
    expect(host.querySelector('[data-testid="task-prompt"]')).not.toBeNull();
  });
});

describe('questions raised during the demo show in step 4', () => {
  const at: Seed = { start: 'agents', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: null };
  const login = (over: Record<string, unknown> = {}) => ({
    id: 'q-login',
    asker: 'session-1',
    question: 'Which login should this Codex helper use?',
    choices: [{ id: 'once:main', label: 'Main login' }, { id: 'always:main', label: 'Always use Main login' }],
    allow_free_text: false,
    context: 'Codex has no other login yet.',
    urgency: 'normal',
    created_at_ms: Date.now() + 1000,
    expires_at_ms: Date.now() + 600_000,
    state: 'pending',
    kind: 'helper_login',
    ...over,
  });

  it('a helper login question appears inline with its buttons, and answering sends the pick', async () => {
    const d = deps();
    const m = await mount(d, at);
    await tap('Continue');
    await tap(T.connectButton(['Claude Code', 'Codex']));
    await tap('Continue');
    await tap('Continue');
    await tap(T.taskStart('Claude'));
    const answerQuestion = vi.fn(async () => undefined);
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }], { asked: { questions: [login()], answerQuestion, dismissQuestion: vi.fn() } }));
    const card = host.querySelector('[data-testid="task-question"]')!;
    expect(card.textContent).toContain('Which login should this Codex helper use?');
    expect(text()).toContain(T.taskAsking('Claude'));
    expect(button('Continue')!.disabled).toBe(true);
    await tap('Main login');
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect((answerQuestion.mock.calls[0] as unknown[])[0]).toBe('q-login');
  });

  it('a question from before the demo, and an answered one, stay out', async () => {
    const d = deps();
    const m = await mount(d, at);
    await tap('Continue');
    await tap(T.connectButton(['Claude Code', 'Codex']));
    await tap('Continue');
    await tap('Continue');
    await tap(T.taskStart('Claude'));
    const old = login({ id: 'q-old', created_at_ms: 1 });
    const done = login({ id: 'q-done', state: 'answered' });
    await m.update(cockpit([{ id: 'pane-main', status: 'running' }], { asked: { questions: [old, done], answerQuestion: vi.fn(), dismissQuestion: vi.fn() } }));
    expect(host.querySelector('[data-testid="task-question"]')).toBeNull();
  });
});

describe('step 4 shows one trust card and short names', () => {
  const at: Seed = { start: 'agents', look: 'code', project: { path: 'D:/code/shop', name: 'shop', state: 'repo' }, agentId: null };
  it('hides the main agent copy of a question the helper card already asks, and names the helper Codex', async () => {
    const d = deps();
    const m = await mount(d, at);
    await tap('Continue');
    await tap(T.connectButton(['Claude Code', 'Codex']));
    await tap('Continue');
    await tap('Continue');
    await tap(T.taskStart('Claude'));
    const dup = { id: 'q-dup', question: 'Codex is asking whether to trust this folder. Should I answer Trust this folder?', choices: [{ id: 'yes', label: 'Yes' }], allow_free_text: false, urgency: 'normal', created_at_ms: Date.now() + 1000, expires_at_ms: Date.now() + 600000, state: 'pending', pane_id: 'pane-main' };
    const trust = { promptId: 'p-trust', kind: 'trust', text: 'Do you trust this folder?', choices: [{ id: '1', label: 'Trust this folder' }, { id: '2', label: 'No' }], risk: { level: 'low', headline: 'Trust this folder', reasons: ['Codex asks first.'] } };
    const panes = [{ id: 'pane-main', status: 'running' }, { id: 'pane-helper', status: 'waiting_input', parent: 'pane-main', type: 'codex' }];
    await m.update(cockpit(panes, { asked: { questions: [dup], answerQuestion: vi.fn(), dismissQuestion: vi.fn() }, prompts: { 'pane-helper': trust }, names: new Map([['pane-helper', 'Codex CLI']]) }));
    expect(host.querySelector('[data-testid="task-question"]')).toBeNull();
    expect(text()).toContain('Trust this folder');
    const row = host.querySelector('[data-testid="task-helpers"] .fr-agentname')!.textContent;
    expect(row).toBe('Codex');
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
