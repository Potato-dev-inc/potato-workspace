// The first-run welcome as plain data and pure functions: which step comes next, what lets a person
// continue, what a skip does, how a restart resumes, and which settings each choice writes. The
// components only draw this; the tests (model.test.ts) pin it.
//
// Settings keys (Rust reads onboarding_done in `first_run::state`):
//   onboarding_done     absent = never decided, true = finished or skipped, false = show it again
//   onboarding_step     the step the person was on
//   onboarding_project  the folder chosen for the first task
//   onboarding_agent    the agent that was ready, so a restart can still offer the first task
//
// The main path is two screens: Your agents (one "Set up everything" button) and Your project (a folder, or
// "Skip for now"). Nothing is locked: what is not done yet is finished later from the "Finish setup" chip.
// Old saved steps are migrated by `migrateStep`.

export const STEPS = ['agents', 'project'] as const;
export type StepId = (typeof STEPS)[number];

/** The three answers to "How do you work?". The first is the normal cockpit; the other two are Simple mode. */
export type Look = 'code' | 'ai' | 'none';
export const LOOKS: Look[] = ['code', 'ai', 'none'];

export const isSimpleLook = (look: Look | null): boolean => look === 'ai' || look === 'none';

export interface ProjectPick {
  path: string;
  name: string;
  /** Git state of the folder (a quiet hint only; nothing on these screens needs Git). */
  state: 'repo' | 'no_commits' | 'folder' | 'missing';
}

/** An agent that passed its test; the first task can use it. */
export interface ReadyAgent {
  id: string;
  label: string;
}

export interface Flow {
  step: StepId;
  look: Look | null;
  /** The agents that passed their test (the Set up agents list says Ready). */
  ready: ReadyAgent[];
  project: ProjectPick | null;
  /** The welcome is over (finished or skipped): the host closes it and writes onboarding_done. */
  finished: boolean;
}

export type Action =
  | { type: 'look'; look: Look }
  | { type: 'agents'; ready: ReadyAgent[] }
  | { type: 'project'; project: ProjectPick | null }
  | { type: 'next' }
  | { type: 'back' }
  /** "Skip for now" on one step: go on without what the step gives. */
  | { type: 'skip' }
  /** "Skip setup": leave the whole welcome from any step. */
  | { type: 'skipAll' }
  | { type: 'go'; step: StepId };

export const stepIndex = (step: StepId): number => STEPS.indexOf(step);
export const isStep = (value: unknown): value is StepId => typeof value === 'string' && (STEPS as readonly string[]).includes(value);

export function initialFlow(overrides: Partial<Flow> = {}): Flow {
  return { step: 'agents', look: null, ready: [], project: null, finished: false, ...overrides };
}

/** Nothing is locked: every screen can be left. What is not done is finished later ("Finish setup"). */
export const canContinue = (_flow: Flow): boolean => true;

/** Set-up that is still open when the welcome closes: the "Finish setup" chip shows while this is true. */
export function setupPending(project: ProjectPick | null, setupDone: boolean): boolean {
  return !setupDone || project === null;
}

function advance(flow: Flow): Flow {
  const i = stepIndex(flow.step);
  // The last step's button closes the welcome.
  if (i >= STEPS.length - 1) return { ...flow, finished: true };
  return { ...flow, step: STEPS[i + 1] };
}

const sameAgents = (a: ReadyAgent[], b: ReadyAgent[]): boolean => a.length === b.length && a.every((x, i) => x.id === b[i].id);

export function reduce(flow: Flow, action: Action): Flow {
  switch (action.type) {
    case 'look':
      return { ...flow, look: action.look };
    case 'agents':
      // The doctor reports its list again after every check; the same agents change nothing.
      return sameAgents(flow.ready, action.ready) ? flow : { ...flow, ready: action.ready };
    case 'project':
      return { ...flow, project: action.project };
    case 'next':
      return canContinue(flow) ? advance(flow) : flow;
    case 'skip':
      return advance(flow);
    case 'skipAll':
      return { ...flow, finished: true };
    case 'back': {
      const i = stepIndex(flow.step);
      return i === 0 ? flow : { ...flow, step: STEPS[i - 1] };
    }
    case 'go':
      return { ...flow, step: action.step };
  }
}

/**
 * Where a restart or a reopen lands. A saved step is kept when what it needs is still there; the first
 * task needs a folder, so without one the person lands on the folder step instead. A reopen
 * (`fresh`) always starts at the top.
 */
export function resumeStep(saved: string | null | undefined, _haveProject: boolean, fresh = false): StepId {
  const step = fresh ? null : migrateStep(saved);
  if (!step) return STEPS[0];
  return step;
}

/**
 * A step id saved by an older build, as a step of today's list. The old Welcome step is now part of
 * Your agents; Phone and Agent pack moved off the path, so someone who got that far is at Done.
 */
export function migrateStep(saved: string | null | undefined): StepId | null {
  if (isStep(saved)) return saved;
  if (saved === 'welcome' || saved === 'connect') return 'agents';
  if (saved === 'task' || saved === 'done' || saved === 'phone' || saved === 'pack') return 'project';
  return null;
}

/** What the cockpit asks Rust at start (`first_run_state`). */
export interface FirstRunState {
  /** Should the welcome be on screen? */
  show: boolean;
  /** True when the person never decided (`onboarding_done` absent). */
  auto: boolean;
  step: string | null;
}

/**
 * The welcome shows when Rust says so. An automatic show (never decided) is vetoed when this install
 * has already had a pane: an existing user who updates must not meet a welcome. A requested show
 * (palette, Settings) is never vetoed.
 */
export function shouldShowWelcome(state: FirstRunState | null, everSpawned: boolean, paneCount: number): boolean {
  if (!state || !state.show) return false;
  if (!state.auto) return true;
  return !everSpawned && paneCount === 0;
}

// ---- what each choice writes (all through the ordinary settings patch) ----

export const lookPatch = (look: Look) => ({ simple_mode: isSimpleLook(look) });
export const stepPatch = (step: StepId) => ({ onboarding_step: step });
export const projectPatch = (project: ProjectPick | null) => ({ onboarding_project: project ? project.path : null });
export const agentPatch = (ready: ReadyAgent[]) => ({ onboarding_agent: ready.length > 0 ? ready[0].id : null });
/** Finished or skipped: never shown again on its own. The saved step and folder are dropped. */
export const finishPatch = () => ({ onboarding_done: true, onboarding_step: null, onboarding_project: null, onboarding_agent: null });
/** Asked for again (palette, Settings): `false` makes every window show it. */
export const reopenPatch = () => ({ onboarding_done: false, onboarding_step: 'agents' });

/** The Simple/normal look implied by the saved `simple_mode`, for pre-selecting step 1 on a reopen. */
export const lookFromSettings = (simpleMode: boolean | undefined): Look | null => (simpleMode === undefined ? null : simpleMode ? 'ai' : 'code');

/** Agents that passed their test, in list order. */
export function readyAgents<T extends { id: string; label: string; state: string }>(rows: T[]): ReadyAgent[] {
  return rows.filter((r) => r.state === 'ready').map((r) => ({ id: r.id, label: r.label }));
}

/** Agents the welcome can use now: installed and not waiting for a sign-in. No Test press needed. */
export function usableAgents<T extends { id: string; label: string; state: string; installed: boolean }>(rows: T[]): ReadyAgent[] {
  return rows.filter((r) => r.installed && (r.state === 'ready' || r.state === 'unchecked')).map((r) => ({ id: r.id, label: r.label }));
}

/** The agents the welcome looks for, in the order it shows them. */
export const WATCHED_AGENTS = ['claude', 'codex', 'cursor_agent', 'opencode'] as const;

/** The agents warmed while the person is still on step 1: Claude, and Codex when it is there. */
export function warmTargets(ready: ReadyAgent[]): string[] {
  const ids = ready.map((a) => a.id);
  const main = ids.includes('claude') ? 'claude' : ids[0];
  return [...new Set([main, ids.includes('codex') ? 'codex' : undefined].filter((x): x is string => !!x))];
}

/** The short name of an agent for a sentence: "Codex CLI" is "Codex", "Cursor Agent CLI" is "Cursor". */
export function shortAgentName(label: string): string {
  return label.replace(/\s*\(API\)$/i, '').replace(/\s+(Agent\s+)?CLI$/i, '').replace(/\s+Agent$/i, '').trim() || label;
}
