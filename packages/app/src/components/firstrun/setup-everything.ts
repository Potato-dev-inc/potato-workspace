// "Set up everything" on the first screen: three steps that already exist elsewhere, run one after the other by
// one button. 1) the chat add-ons of the agents found (Settings > Agents > Chat add-ons), 2) Potato Workspace
// added to the agents' own settings (Settings > Connections, `agent_pack_apply`), 3) two agents kept ready
// (Settings > Preload). A step that fails is tried again by itself; the third failure stops the run so the
// shared SetupStepBlock can offer "Let <agent> fix it". Nothing here shows a command.
import type { AcpAddonApi } from '../../lib/acpAddon';
import type { AgentPackApi } from '../../lib/agent-pack';
import { errorSentence } from '../../lib/sayError';
import type { SetupStep, SetupStepStatus } from '../common/SetupStepBlock';
import { warmTargets, type ReadyAgent } from './model';
import { startWarming, type WarmApi } from './warm';

export type EverythingStepId = 'addons' | 'connect' | 'ready';
export const EVERYTHING_STEPS: readonly EverythingStepId[] = ['addons', 'connect', 'ready'];
export const MAX_TRIES = 3;

export interface EverythingStep {
  id: EverythingStepId;
  status: SetupStepStatus;
  tries: number;
  output: string;
}

export interface EverythingRun {
  ok: boolean;
  steps: EverythingStep[];
  failed: EverythingStepId | null;
}

export interface EverythingApis {
  addons: Pick<AcpAddonApi, 'list' | 'install'>;
  pack: Pick<AgentPackApi, 'apply'>;
  warm: WarmApi;
}

export const freshEverything = (): EverythingStep[] => EVERYTHING_STEPS.map((id) => ({ id, status: 'waiting', tries: 0, output: '' }));

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Installs the add-on of every agent that is here and lacks it. Returns what to print when one did not install. */
async function installAddons(api: EverythingApis['addons'], agents: ReadyAgent[], pollMs: number): Promise<string> {
  const list = await api.list();
  // Chat is off, or this build has no add-ons: nothing to install, nothing wrong.
  if (!list.labsEnabled) return '';
  const here = new Set(agents.map((a) => a.id));
  const problems: string[] = [];
  for (const addon of list.addons) {
    if (!here.has(addon.agent) || addon.state === 'installed') continue;
    let status = await api.install(addon.agent);
    // An install that is still running in the background: look again until it ends (bounded).
    for (let i = 0; i < 120 && status.state === 'installing'; i++) {
      await wait(pollMs);
      const again = (await api.list()).addons.find((a) => a.agent === addon.agent);
      if (again) status = again;
    }
    if (status.state !== 'installed') problems.push(`${status.label}: ${status.detail || 'The add-on did not install.'}`);
  }
  return problems.join('\n');
}

/**
 * Runs the three steps. `onChange` gets a fresh copy after each change. The first step that fails three
 * times stops the run. `ready` are the agents found on this PC; `project` is where warm agents start.
 */
export async function runSetupEverything(opts: {
  apis: EverythingApis;
  ready: ReadyAgent[];
  project: string | null;
  onChange?: (steps: EverythingStep[]) => void;
  /** The pause before a failed step runs again (tests give 0). */
  pauseMs?: number;
  isCancelled?: () => boolean;
}): Promise<EverythingRun> {
  const pause = opts.pauseMs ?? 1500;
  const steps = freshEverything();
  const push = () => opts.onChange?.(steps.map((s) => ({ ...s })));
  push();
  for (const step of steps) {
    let passed = false;
    for (let attempt = 1; attempt <= MAX_TRIES && !passed; attempt++) {
      if (opts.isCancelled?.()) return { ok: false, steps, failed: step.id };
      step.tries = attempt;
      step.status = attempt === 1 ? 'running' : 'retrying';
      push();
      try {
        if (step.id === 'addons') {
          step.output = await installAddons(opts.apis.addons, opts.ready, pause > 0 ? 1000 : 0);
          passed = step.output === '';
        } else if (step.id === 'connect') {
          await opts.apis.pack.apply();
          step.output = '';
          passed = true;
        } else {
          // Warming never throws; "nothing" (no agent has a warm mode) is not a failure.
          await startWarming(opts.apis.warm, warmTargets(opts.ready), opts.project);
          step.output = '';
          passed = true;
        }
      } catch (e) {
        passed = false;
        step.output = errorSentence(e);
      }
      if (!passed && attempt < MAX_TRIES && pause > 0) await wait(pause);
    }
    step.status = passed ? 'done' : 'failed';
    push();
    if (!passed) return { ok: false, steps, failed: step.id };
  }
  return { ok: true, steps, failed: null };
}

/** The task the person's agent gets for "Let <agent> fix it". The person presses Send. */
export function everythingTask(run: EverythingRun, labels: Record<EverythingStepId, string>): string {
  const failed = run.steps.find((s) => s.id === run.failed);
  const done = run.steps.filter((s) => s.status === 'done').map((s) => labels[s.id]);
  return [
    "I'm not a developer. Please finish this for me, and explain each thing you do in plain words.",
    '',
    'Goal: finish the first-time setup of Potato Workspace on this PC: the chat add-ons of my agents, adding Potato Workspace to my agents, and keeping two agents ready.',
    `Steps that worked: ${done.length ? done.join(', ') : 'none'}.`,
    `The step that failed ${MAX_TRIES} times: ${failed ? labels[failed.id] : 'unknown'}.`,
    'What it printed:',
    (failed?.output ?? '').slice(-3000) || '(nothing was printed)',
    '',
    'Please find out why, fix it, and tell me when it works.',
  ].join('\n');
}

/** The steps as the shared block draws them. */
export function asSetupSteps(steps: readonly EverythingStep[], labels: Record<EverythingStepId, string>): SetupStep[] {
  return steps.map((s) => ({ id: s.id, label: labels[s.id], status: s.status, tries: s.tries, output: s.output }));
}
