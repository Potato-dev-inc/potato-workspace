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
// The main path is four short steps and a done screen. Phone and Agent pack left the path; Done links
// to them ("More you can set up"). Old saved steps are migrated by `migrateStep`.
//   simple_mode         written the moment a look is chosen; the cockpit keeps its normal face until the
//                       welcome closes (CockpitApp), so sign-in and install windows stay visible.

export const STEPS = ['agents', 'connect', 'project', 'task', 'done'] as const;
export type StepId = (typeof STEPS)[number];

/** Screens reached from Done, off the main path. */
export const MORE = ['phone', 'pack'] as const;
export type MoreId = (typeof MORE)[number];

/** The three answers to "How do you work?". The first is the normal cockpit; the other two are Simple mode. */
export type Look = 'code' | 'ai' | 'none';
export const LOOKS: Look[] = ['code', 'ai', 'none'];

export const isSimpleLook = (look: Look | null): boolean => look === 'ai' || look === 'none';

export interface ProjectPick {
  path: string;
  name: string;
  /** Git state of the folder; the first task needs `repo` (a separate copy is made from it). */
  state: 'repo' | 'no_commits' | 'folder' | 'missing';
}

/** Does the connection to Potato Workspace sit in the agents' config files? `unknown` until looked at. */
export type Connected = 'unknown' | 'yes' | 'no';

export type TaskState = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

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
  /** Step 2: Potato Workspace is in at least one agent's config. */
  connected: Connected;
  task: TaskState;
  /** The welcome is over (finished or skipped): the host closes it and writes onboarding_done. */
  finished: boolean;
}

export type Action =
  | { type: 'look'; look: Look }
  | { type: 'agents'; ready: ReadyAgent[] }
  | { type: 'connected'; connected: Connected }
  | { type: 'project'; project: ProjectPick | null }
  | { type: 'task'; task: TaskState }
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
  return { step: 'agents', look: null, ready: [], project: null, connected: 'unknown', task: 'idle', finished: false, ...overrides };
}

/** What a step needs before "Continue" is on. Skip is always on. */
export function canContinue(flow: Flow): boolean {
  switch (flow.step) {
    case 'agents':
      return flow.ready.length > 0;
    case 'connect':
      return flow.connected === 'yes';
    case 'project':
      return flow.project !== null && flow.project.state === 'repo';
    case 'task':
      return flow.task === 'done';
    default:
      return true;
  }
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
      // A different folder starts the first task over.
      return { ...flow, project: action.project, task: flow.project?.path === action.project?.path ? flow.task : 'idle' };
    case 'connected':
      return flow.connected === action.connected ? flow : { ...flow, connected: action.connected };
    case 'task':
      return { ...flow, task: action.task };
    case 'next':
      return canContinue(flow) ? advance(flow) : flow;
    case 'skip': {
      const skipped = flow.step === 'task' && flow.task !== 'done' ? { ...flow, task: 'skipped' as const } : flow;
      return advance(skipped);
    }
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
export function resumeStep(saved: string | null | undefined, haveProject: boolean, fresh = false): StepId {
  const step = fresh ? null : migrateStep(saved);
  if (!step) return STEPS[0];
  if (step === 'task' && !haveProject) return 'project';
  return step;
}

/**
 * A step id saved by an older build, as a step of today's list. The old Welcome step is now part of
 * Your agents; Phone and Agent pack moved off the path, so someone who got that far is at Done.
 */
export function migrateStep(saved: string | null | undefined): StepId | null {
  if (isStep(saved)) return saved;
  if (saved === 'welcome') return 'agents';
  if (saved === 'phone' || saved === 'pack') return 'done';
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

/** What the last step runs: the main agent, the second agent it is told to ask (if any). */
export interface DemoPlan {
  main: ReadyAgent;
  helper: ReadyAgent | null;
}

export function planDemo(ready: ReadyAgent[]): DemoPlan | null {
  if (ready.length === 0) return null;
  const main = ready.find((a) => a.id === 'claude') ?? ready[0];
  const others = ready.filter((a) => a.id !== main.id);
  const helper = others.find((a) => a.id === 'codex') ?? others[0] ?? null;
  return { main, helper };
}

/** The pane of the demo and the panes it started (helpers nested under it), from the pane list. */
export function demoHelpers<P extends { info: { id: string; parent_pane_id?: string | null }; status: string }>(list: readonly P[], mainPane: string | null): P[] {
  return mainPane ? list.filter((p) => p.info.parent_pane_id === mainPane) : [];
}

/** A main agent that stopped without starting any helper is taken as finished after this long. */
export const HELPER_GRACE_MS = 15_000;

/**
 * The demo is over when the main pane worked and then stopped, and every helper it started has
 * stopped too. With a helper expected, one has to have appeared (the nested pane is the point); an
 * agent that answered alone is reported as `alone` after `HELPER_GRACE_MS` of quiet.
 */
export type DemoEnd = 'done' | 'alone';

export function demoFinished(sawRunning: boolean, mainStatus: string | undefined, helperStatuses: string[], expectHelper: boolean, idleForMs = 0): DemoEnd | null {
  if (!sawRunning || mainStatus === undefined || mainStatus === 'running' || mainStatus === 'waiting_input') return null;
  if (helperStatuses.some((s) => s === 'running')) return null;
  // The agent stopped without starting a helper: not the demo, and not to be called a success.
  if (expectHelper && helperStatuses.length === 0) return idleForMs >= HELPER_GRACE_MS ? 'alone' : null;
  return 'done';
}

/** The short name of an agent for a sentence: "Codex CLI" is "Codex", "Cursor Agent CLI" is "Cursor". */
export function shortAgentName(label: string): string {
  return label.replace(/\s*\(API\)$/i, '').replace(/\s+(Agent\s+)?CLI$/i, '').replace(/\s+Agent$/i, '').trim() || label;
}

/**
 * Questions the demo has to show: any open question that names the demo pane or one of its helpers, and any
 * other open question raised since the demo started (a helper's "which login?" card carries no pane of its
 * own). Consent and usage-limit cards have their own cards in the Inbox and are left there.
 */
export function demoQuestions<Q extends { id: string; state: string; pane_id?: string; created_at_ms: number; consent?: unknown; limit?: unknown }>(
  questions: readonly Q[],
  paneIds: readonly string[],
  startedAt: number,
): Q[] {
  return questions.filter(
    (q) => q.state === 'pending' && !q.consent && !q.limit && ((q.pane_id !== undefined && paneIds.includes(q.pane_id)) || (startedAt > 0 && q.created_at_ms >= startedAt - 5_000)),
  );
}

/**
 * An agent that sees its helper stop at a question (a folder-trust prompt) often asks the person the same
 * thing itself ("Should I answer Trust this folder?"). While a helper's own card is on screen, that second,
 * plain question from the main agent is left out: answering the real card is enough. Cards Potato Workspace
 * raises itself (the login card, budget and so on) carry a kind and are always kept.
 */
export function withoutDuplicateAsks<Q extends { kind?: string; pane_id?: string }>(questions: readonly Q[], helperCardShown: boolean, mainPane: string | null): Q[] {
  if (!helperCardShown) return [...questions];
  return questions.filter((q) => q.kind !== undefined || (q.pane_id !== undefined && q.pane_id !== mainPane));
}
