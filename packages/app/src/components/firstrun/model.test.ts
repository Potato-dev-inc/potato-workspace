// The welcome's step logic: two screens, nothing locked, skip, resume and migration, shown once.
import { describe, expect, it } from 'vitest';
import {
  canContinue,
  finishPatch,
  initialFlow,
  isSimpleLook,
  isStep,
  lookFromSettings,
  lookPatch,
  migrateStep,
  reduce,
  reopenPatch,
  resumeStep,
  setupPending,
  shortAgentName,
  shouldShowWelcome,
  STEPS,
  stepPatch,
  usableAgents,
  warmTargets,
  type Action,
  type Flow,
  type ProjectPick,
} from './model';

const folder: ProjectPick = { path: 'D:/code/shop', name: 'shop', state: 'folder' };
const claude = { id: 'claude', label: 'Claude' };
const run = (flow: Flow, ...actions: Action[]): Flow => actions.reduce(reduce, flow);

describe('steps', () => {
  it('are two screens, in order', () => {
    expect(STEPS).toEqual(['agents', 'project']);
  });

  it('nothing is locked: Continue is on with no agent, no folder and no set-up', () => {
    for (const step of STEPS) expect(canContinue(initialFlow({ step }))).toBe(true);
  });

  it('the whole way through, then the last button finishes (with or without a folder)', () => {
    let flow = run(initialFlow(), { type: 'next' });
    expect(flow.step).toBe('project');
    expect(flow.finished).toBe(false);
    expect(run(flow, { type: 'next' }).finished).toBe(true);
    flow = run(flow, { type: 'project', project: folder }, { type: 'next' });
    expect(flow.finished).toBe(true);
  });

  it('a folder without Git is a fine pick', () => {
    expect(run(initialFlow({ step: 'project' }), { type: 'project', project: folder }).project).toEqual(folder);
  });

  it('"Finish setup" stays on while set-up or the folder is open', () => {
    expect(setupPending(null, false)).toBe(true);
    expect(setupPending(folder, false)).toBe(true);
    expect(setupPending(null, true)).toBe(true);
    expect(setupPending(folder, true)).toBe(false);
  });
});

describe('skip', () => {
  it('Skip for now goes on from the first screen and finishes from the last', () => {
    expect(run(initialFlow({ step: 'agents' }), { type: 'skip' }).step).toBe('project');
    expect(run(initialFlow({ step: 'project' }), { type: 'skip' }).finished).toBe(true);
  });

  it('Skip setup ends the welcome from any step', () => {
    for (const step of STEPS) expect(run(initialFlow({ step }), { type: 'skipAll' }).finished).toBe(true);
  });

  it('Back never leaves the first step', () => {
    expect(run(initialFlow(), { type: 'back' }).step).toBe('agents');
    expect(run(initialFlow({ step: 'project' }), { type: 'back' }).step).toBe('agents');
  });

  it('the same agents reported again are the same state (no extra render)', () => {
    const flow = initialFlow({ step: 'agents', ready: [claude] });
    expect(run(flow, { type: 'agents', ready: [{ ...claude }] })).toBe(flow);
  });
});

describe('resume and migration', () => {
  it('lands on the saved step', () => {
    expect(resumeStep('agents', false)).toBe('agents');
    expect(resumeStep('project', false)).toBe('project');
  });
  it('an unknown or missing step, and a reopen, start at the top', () => {
    expect(resumeStep(undefined, false)).toBe('agents');
    expect(resumeStep(null, true)).toBe('agents');
    expect(resumeStep('bogus', true)).toBe('agents');
    expect(resumeStep('project', true, true)).toBe('agents');
  });
  it('an old saved step becomes a step of today', () => {
    expect(migrateStep('welcome')).toBe('agents');
    expect(migrateStep('connect')).toBe('agents');
    for (const old of ['task', 'done', 'phone', 'pack']) expect(migrateStep(old)).toBe('project');
    for (const id of STEPS) expect(migrateStep(id)).toBe(id);
    expect(migrateStep('bogus')).toBeNull();
    expect(migrateStep(undefined)).toBeNull();
    expect(resumeStep('task', false)).toBe('project');
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
  it('keeps Claude and Codex ready when both are there, the first agent otherwise', () => {
    expect(warmTargets([{ id: 'codex', label: 'Codex' }, claude])).toEqual(['claude', 'codex']);
    expect(warmTargets([claude])).toEqual(['claude']);
    expect(warmTargets([{ id: 'opencode', label: 'OpenCode' }])).toEqual(['opencode']);
    expect(warmTargets([])).toEqual([]);
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
