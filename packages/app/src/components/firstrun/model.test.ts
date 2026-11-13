// The welcome's step logic: skip, resume and migration, Simple versus normal, shown once, the demo plan.
import { describe, expect, it } from 'vitest';
import {
  canContinue,
  demoFinished,
  demoHelpers,
  finishPatch,
  HELPER_GRACE_MS,
  initialFlow,
  isSimpleLook,
  isStep,
  lookFromSettings,
  lookPatch,
  migrateStep,
  planDemo,
  shortAgentName,
  reduce,
  reopenPatch,
  resumeStep,
  shouldShowWelcome,
  STEPS,
  stepPatch,
  usableAgents,
  warmTargets,
  withoutDuplicateAsks,
  type Action,
  type Flow,
  type ProjectPick,
} from './model';

const repo: ProjectPick = { path: 'D:/code/shop', name: 'shop', state: 'repo' };
const claude = { id: 'claude', label: 'Claude' };
const run = (flow: Flow, ...actions: Action[]): Flow => actions.reduce(reduce, flow);

describe('steps', () => {
  it('are four short steps and a done screen, in order', () => {
    expect(STEPS).toEqual(['agents', 'connect', 'project', 'task', 'done']);
  });

  it('Continue needs what each step is for', () => {
    expect(canContinue(initialFlow({ step: 'agents' }))).toBe(false); // no agent is ready
    expect(canContinue(initialFlow({ step: 'agents', ready: [claude] }))).toBe(true);
    expect(canContinue(initialFlow({ step: 'agents', ready: [claude], look: null }))).toBe(true); // the look is optional now
    expect(canContinue(initialFlow({ step: 'connect' }))).toBe(false);
    expect(canContinue(initialFlow({ step: 'connect', connected: 'no' }))).toBe(false);
    expect(canContinue(initialFlow({ step: 'connect', connected: 'yes' }))).toBe(true); // already connected: Next at once
    expect(canContinue(initialFlow({ step: 'project' }))).toBe(false);
    expect(canContinue(initialFlow({ step: 'project', project: { ...repo, state: 'folder' } }))).toBe(false); // needs Git first
    expect(canContinue(initialFlow({ step: 'project', project: repo }))).toBe(true);
    expect(canContinue(initialFlow({ step: 'task' }))).toBe(false);
    expect(canContinue(initialFlow({ step: 'task', task: 'running' }))).toBe(false);
    expect(canContinue(initialFlow({ step: 'task', task: 'done' }))).toBe(true);
    expect(canContinue(initialFlow({ step: 'done' }))).toBe(true);
  });

  it('next does nothing while the step is not satisfied', () => {
    const flow = initialFlow({ step: 'agents' });
    expect(run(flow, { type: 'next' })).toBe(flow);
  });

  it('the whole way through, then the last button finishes', () => {
    let flow = initialFlow();
    expect(flow.step).toBe('agents');
    flow = run(flow, { type: 'agents', ready: [claude] }, { type: 'next' });
    expect(flow.step).toBe('connect');
    flow = run(flow, { type: 'connected', connected: 'yes' }, { type: 'next' });
    expect(flow.step).toBe('project');
    flow = run(flow, { type: 'project', project: repo }, { type: 'next' });
    expect(flow.step).toBe('task');
    flow = run(flow, { type: 'task', task: 'done' }, { type: 'next' });
    expect(flow.step).toBe('done');
    expect(flow.finished).toBe(false);
    expect(run(flow, { type: 'next' }).finished).toBe(true);
  });

  it('the same connection state reported again is the same state', () => {
    const flow = initialFlow({ step: 'connect', connected: 'yes' });
    expect(run(flow, { type: 'connected', connected: 'yes' })).toBe(flow);
  });
});

describe('skip', () => {
  it('Skip for now goes on from every step without what the step gives', () => {
    for (const step of STEPS.slice(0, -1)) {
      const next = run(initialFlow({ step }), { type: 'skip' });
      expect(next.step).toBe(STEPS[STEPS.indexOf(step) + 1]);
      expect(next.finished).toBe(false);
    }
  });

  it('skipping the task marks it skipped, but keeps a finished one', () => {
    expect(run(initialFlow({ step: 'task' }), { type: 'skip' }).task).toBe('skipped');
    expect(run(initialFlow({ step: 'task', task: 'done' }), { type: 'skip' }).task).toBe('done');
  });

  it('Skip setup ends the welcome from any step', () => {
    for (const step of STEPS) expect(run(initialFlow({ step }), { type: 'skipAll' }).finished).toBe(true);
  });

  it('Back never leaves the first step', () => {
    expect(run(initialFlow(), { type: 'back' }).step).toBe('agents');
    expect(run(initialFlow({ step: 'project' }), { type: 'back' }).step).toBe('connect');
  });

  it('a different folder starts the demo over; the same one keeps it', () => {
    const base = initialFlow({ step: 'project', project: repo, task: 'done' });
    expect(run(base, { type: 'project', project: { ...repo } }).task).toBe('done');
    expect(run(base, { type: 'project', project: { ...repo, path: 'D:/code/other' } }).task).toBe('idle');
  });

  it('the same agents reported again are the same state (no extra render)', () => {
    const flow = initialFlow({ step: 'agents', ready: [claude] });
    expect(run(flow, { type: 'agents', ready: [{ ...claude }] })).toBe(flow);
  });
});

describe('resume and migration', () => {
  it('lands on the saved step', () => {
    expect(resumeStep('agents', false)).toBe('agents');
    expect(resumeStep('connect', false)).toBe('connect');
    expect(resumeStep('done', false)).toBe('done');
  });
  it('a saved task step needs a folder; without one it lands on the folder step', () => {
    expect(resumeStep('task', true)).toBe('task');
    expect(resumeStep('task', false)).toBe('project');
  });
  it('an unknown or missing step, and a reopen, start at the top', () => {
    expect(resumeStep(undefined, false)).toBe('agents');
    expect(resumeStep(null, true)).toBe('agents');
    expect(resumeStep('bogus', true)).toBe('agents');
    expect(resumeStep('done', true, true)).toBe('agents');
  });
  it('an old saved step becomes a step of today', () => {
    expect(migrateStep('welcome')).toBe('agents');
    expect(migrateStep('phone')).toBe('done');
    expect(migrateStep('pack')).toBe('done');
    for (const id of STEPS) expect(migrateStep(id)).toBe(id);
    expect(migrateStep('bogus')).toBeNull();
    expect(migrateStep(undefined)).toBeNull();
    expect(resumeStep('welcome', false)).toBe('agents');
    expect(resumeStep('pack', true)).toBe('done');
    expect(resumeStep('phone', false)).toBe('done');
  });
  it('the step written on a reopen is a step that exists', () => {
    expect(isStep(reopenPatch().onboarding_step)).toBe(true);
    for (const id of STEPS) expect(isStep(stepPatch(id).onboarding_step)).toBe(true);
  });
});

describe('agents the welcome uses', () => {
  const row = (id: string, state: string, installed = true) => ({ id, label: id, state, installed });
  it('an installed agent that is not waiting for a sign-in counts, tested or not', () => {
    const rows = [row('claude', 'unchecked'), row('codex', 'ready'), row('cursor_agent', 'needs_login'), row('opencode', 'not_installed', false), row('x', 'error')];
    expect(usableAgents(rows).map((a) => a.id)).toEqual(['claude', 'codex']);
  });
  it('warms Claude and Codex when both are there, the first agent otherwise', () => {
    expect(warmTargets([{ id: 'codex', label: 'Codex' }, claude])).toEqual(['claude', 'codex']);
    expect(warmTargets([claude])).toEqual(['claude']);
    expect(warmTargets([{ id: 'opencode', label: 'OpenCode' }])).toEqual(['opencode']);
    expect(warmTargets([])).toEqual([]);
  });
  it('the demo asks Codex when it is ready, else the best other agent, else nobody', () => {
    const codex = { id: 'codex', label: 'Codex' };
    const cursor = { id: 'cursor_agent', label: 'Cursor' };
    expect(planDemo([])).toBeNull();
    expect(planDemo([cursor, codex, claude])).toEqual({ main: claude, helper: codex });
    expect(planDemo([claude, cursor])).toEqual({ main: claude, helper: cursor });
    expect(planDemo([claude])).toEqual({ main: claude, helper: null });
    expect(planDemo([codex])).toEqual({ main: codex, helper: null });
  });
});

describe('the demo', () => {
  const pane = (id: string, status: string, parent?: string) => ({ info: { id, parent_pane_id: parent ?? null }, status });
  it('helpers are the panes the demo pane started', () => {
    const list = [pane('a', 'running'), pane('b', 'running', 'a'), pane('c', 'idle', 'zzz')];
    expect(demoHelpers(list, 'a').map((p) => p.info.id)).toEqual(['b']);
    expect(demoHelpers(list, null)).toEqual([]);
  });
  it('is finished once the main pane worked and stopped, and the helpers stopped', () => {
    expect(demoFinished(false, 'idle', ['idle'], true)).toBeNull(); // never seen working
    expect(demoFinished(true, 'running', ['idle'], true)).toBeNull();
    expect(demoFinished(true, 'waiting_input', ['idle'], true)).toBeNull(); // an approval is waiting
    expect(demoFinished(true, undefined, ['idle'], true)).toBeNull();
    expect(demoFinished(true, 'idle', ['running'], true)).toBeNull(); // a helper still works
    expect(demoFinished(true, 'idle', ['idle'], true)).toBe('done');
    expect(demoFinished(true, 'idle', ['idle', 'error'], true)).toBe('done');
  });
  it('a single-agent demo needs no helper; a two-agent demo waits for one, then lets a lone answer go', () => {
    expect(demoFinished(true, 'idle', [], false)).toBe('done');
    expect(demoFinished(true, 'idle', [], true, 1000)).toBeNull();
    expect(demoFinished(true, 'idle', [], true, HELPER_GRACE_MS)).toBe('alone');
  });
});

describe('duplicate asks', () => {
  const ask = { question: 'Should I answer Trust this folder?', pane_id: 'main' };
  const login = { question: 'Which login?', kind: 'helper_login' };
  it('keeps everything while no helper card is up', () => {
    expect(withoutDuplicateAsks([ask, login], false, 'main')).toHaveLength(2);
  });
  it('drops the main agent plain question while a helper card is up, and keeps cards the app raised', () => {
    expect(withoutDuplicateAsks([ask, login], true, 'main')).toEqual([login]);
    const other = { question: 'About something else', pane_id: 'elsewhere' };
    expect(withoutDuplicateAsks([ask, other], true, 'main')).toEqual([other]);
  });
});

describe('agent names', () => {
  it('uses the short name in a sentence', () => {
    expect(shortAgentName('Codex CLI')).toBe('Codex');
    expect(shortAgentName('Cursor Agent CLI')).toBe('Cursor');
    expect(shortAgentName('OpenCode (API)')).toBe('OpenCode');
    expect(shortAgentName('Claude')).toBe('Claude');
  });
});

describe('Simple or normal', () => {
  it('"I write code" is the normal cockpit; the other two answers are Simple mode', () => {
    expect(isSimpleLook('code')).toBe(false);
    expect(isSimpleLook('ai')).toBe(true);
    expect(isSimpleLook('none')).toBe(true);
    expect(isSimpleLook(null)).toBe(false);
    expect(lookPatch('code')).toEqual({ simple_mode: false });
    expect(lookPatch('ai')).toEqual({ simple_mode: true });
    expect(lookPatch('none')).toEqual({ simple_mode: true });
  });
  it('a reopen pre-selects what the settings already say', () => {
    expect(lookFromSettings(undefined)).toBeNull();
    expect(lookFromSettings(false)).toBe('code');
    expect(lookFromSettings(true)).toBe('ai');
  });
});

describe('shown once', () => {
  const auto = { show: true, auto: true, step: null };
  it('an automatic show happens on a fresh install with no panes', () => {
    expect(shouldShowWelcome(auto, false, 0)).toBe(true);
  });
  it('an automatic show is vetoed for someone who has used this install', () => {
    expect(shouldShowWelcome(auto, true, 0)).toBe(false);
    expect(shouldShowWelcome(auto, false, 2)).toBe(false);
  });
  it('a requested show is never vetoed', () => {
    expect(shouldShowWelcome({ show: true, auto: false, step: 'agents' }, true, 3)).toBe(true);
  });
  it('done, or no answer from the backend, never shows', () => {
    expect(shouldShowWelcome({ show: false, auto: false, step: null }, false, 0)).toBe(false);
    expect(shouldShowWelcome(null, false, 0)).toBe(false);
  });
  it('finishing writes done and clears what a resume needed; reopening writes false', () => {
    expect(finishPatch()).toEqual({ onboarding_done: true, onboarding_step: null, onboarding_project: null, onboarding_agent: null });
    expect(reopenPatch()).toEqual({ onboarding_done: false, onboarding_step: 'agents' });
  });
});

describe('continueReason', () => {
  const why = { agents: 'a', connect: 'c', project: 'p', task: 't' };
  it('names the reason on each step while Continue is off, and nothing while it is on', async () => {
    const { continueReason, initialFlow } = await import('./model');
    const base = initialFlow({ start: 'agents', look: 'code', project: null, agentId: null } as never);
    expect(continueReason({ ...base, step: 'agents', ready: [] }, why)).toBe('a');
    expect(continueReason({ ...base, step: 'connect', connected: 'no' }, why)).toBe('c');
    expect(continueReason({ ...base, step: 'project', project: null }, why)).toBe('p');
    expect(continueReason({ ...base, step: 'connect', connected: 'yes' }, why)).toBeNull();
  });
});
