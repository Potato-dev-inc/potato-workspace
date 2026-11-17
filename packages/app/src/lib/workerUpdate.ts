// "Update Worker" / "Set up my Worker" / "Set up stable link": one button that does the steps itself. This file is the
// step runner (no screen code): it runs the fixed steps in order, tries a failed step again up to three times, and
// after the third failure builds the note an agent gets to finish the job. The person never sees a command.
import { invoke } from '@tauri-apps/api/core';
import { chatCapable, tauriAcpChatApi, type AcpLaneView } from './acpChat';
import { errorSentence } from './sayError';
import { workerCheck, type WorkerHealth } from './worker';

export type UpdateStepId = 'prepare' | 'install' | 'login' | 'delete' | 'deploy' | 'check';
export const UPDATE_STEPS: readonly UpdateStepId[] = ['prepare', 'install', 'login', 'deploy', 'check'];
/** "Start fresh on Cloudflare": the same steps with the old Worker deleted (after sign-in) before it is put online again. */
export const FRESH_STEPS: readonly UpdateStepId[] = ['prepare', 'install', 'login', 'delete', 'deploy', 'check'];
export type UpdateStepStatus = 'waiting' | 'running' | 'retrying' | 'done' | 'failed';

export interface UpdateStep {
  id: UpdateStepId;
  status: UpdateStepStatus;
  /** How many times it ran so far. */
  tries: number;
  /** What the last run printed (cleaned by the backend: no tokens). */
  output: string;
}

export interface StepAnswer {
  ok: boolean;
  output: string;
  url?: string;
}

export interface UpdateApi {
  /** Runs one fixed step in the desktop shell. */
  step: (id: Exclude<UpdateStepId, 'check'>, address: string | null, confirmed?: boolean) => Promise<StepAnswer>;
  /** Asks the Worker what it can do (plain GETs). */
  check: (address: string) => Promise<WorkerHealth | null>;
  /** Stops the tool the running step started (only that one). Absent in tests that do not need it. */
  cancel?: () => Promise<unknown> | void;
  /** The pause before a failed step runs again. Absent: 1.5 seconds. Tests give 0. */
  pauseMs?: number;
}

export const tauriUpdateApi: UpdateApi = {
  step: (id, address, confirmed) => invoke<StepAnswer>('worker_update_step', { step: id, address, confirmed: confirmed === true }),
  check: workerCheck,
  cancel: () => invoke<boolean>('worker_update_cancel'),
};

export const MAX_TRIES = 3;

export interface UpdateRun {
  ok: boolean;
  steps: UpdateStep[];
  /** The step that failed three times. */
  failed: UpdateStepId | null;
  /** The Worker's address: the one given, or the one the deploy printed. */
  address: string | null;
}

export const freshSteps = (fresh = false): UpdateStep[] => (fresh ? FRESH_STEPS : UPDATE_STEPS).map((id) => ({ id, status: 'waiting', tries: 0, output: '' }));

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A Worker that answers and lists what it can do (and is not the stable-link-only one). */
export const isUpToDate = (h: WorkerHealth | null): boolean => !!h && h.reachable && h.features.length > 0 && !h.legacyLink;

/**
 * Runs the steps. A step that fails is run again (up to `MAX_TRIES` runs in all). The first step that still fails stops
 * the run. `onChange` gets a fresh copy of the steps after each change. `address`: the Worker to update, or null for a new one.
 */
export async function runWorkerUpdate(opts: {
  address: string | null;
  api?: UpdateApi;
  onChange?: (steps: UpdateStep[]) => void;
  /** The pause before a step runs again (tests give 0). */
  pauseMs?: number;
  isCancelled?: () => boolean;
  /** Delete the saved Worker first (it must be the Worker `address` names). */
  fresh?: boolean;
  /** A failed step this says is pointless to try again (a cancelled sign-in, no workers.dev name yet) stops after the first run. */
  noRetry?: (id: UpdateStepId, output: string) => boolean;
}): Promise<UpdateRun> {
  const api = opts.api ?? tauriUpdateApi;
  const pause = opts.pauseMs ?? api.pauseMs ?? 1500;
  const steps = freshSteps(opts.fresh === true);
  let address = opts.address;
  const push = () => opts.onChange?.(steps.map((s) => ({ ...s })));
  push();
  for (const step of steps) {
    let passed = false;
    for (let attempt = 1; attempt <= MAX_TRIES && !passed; attempt++) {
      if (opts.isCancelled?.()) return { ok: false, steps, failed: step.id, address };
      step.tries = attempt;
      step.status = attempt === 1 ? 'running' : 'retrying';
      push();
      try {
        if (step.id === 'check') {
          const health = address ? await api.check(address) : null;
          passed = isUpToDate(health);
          step.output = passed ? '' : health && health.reachable ? 'The Worker answers, but it still lacks the latest features.' : 'The Worker did not answer yet.';
        } else {
          const answer = await api.step(step.id, address, step.id === 'delete' && opts.fresh === true);
          passed = answer.ok;
          step.output = answer.output;
          if (passed && answer.url && !address) address = answer.url;
        }
      } catch (e) {
        passed = false;
        step.output = errorSentence(e);
      }
      if (!passed && opts.noRetry?.(step.id, step.output)) break;
      if (!passed && attempt < MAX_TRIES && pause > 0) await wait(pause);
    }
    step.status = passed ? 'done' : 'failed';
    push();
    if (!passed) return { ok: false, steps, failed: step.id, address };
  }
  return { ok: true, steps, failed: null, address };
}

/** The agent the person started last on the New agent page (it remembers `agent` or `agent:sign-in`). */
export function lastUsedAgentId(): string | null {
  try {
    const key = localStorage.getItem('pm.newagent.agent');
    return key ? key.split(':')[0] : null;
  } catch {
    return null;
  }
}

/**
 * The one agent a failed job goes to. The same agents the New agent page offers Chat for (Labs on, not disabled),
 * not only ones saved to run as a chat: the hand-off starts a chat itself. Best first: the agent used most recently,
 * then one whose chat is ready (chat lane, add-on in place), then the first one listed. Nothing when none can chat.
 */
export function pickHandoffAgent(view: AcpLaneView | null, lastUsed: string | null = lastUsedAgentId()): { id: string; label: string } | null {
  const all = chatCapable(view);
  const recent = lastUsed ? all.find((a) => a.id.toLowerCase() === lastUsed.toLowerCase()) : undefined;
  const ready = all.find((a) => (a.effective_lane ?? a.lane) === 'acp' && a.addon_installed !== false);
  const agent = recent ?? ready ?? all[0];
  return agent ? { id: agent.id, label: agent.label } : null;
}

const NOTE_OUTPUT_CHARS = 3000;

/** The task the person's agent gets: the goal, the step that failed, and what it printed. The person presses Send. */
export function handoffTask(run: UpdateRun, labels: Record<UpdateStepId, string>): string {
  const failed = run.steps.find((s) => s.id === run.failed);
  const output = (failed?.output ?? '').slice(-NOTE_OUTPUT_CHARS) || '(nothing was printed)';
  const done = run.steps.filter((s) => s.status === 'done').map((s) => labels[s.id]);
  return [
    "I'm not a developer. Please finish this for me, and explain each thing you do in plain words.",
    '',
    `Goal: put the latest Potato Worker online in my own Cloudflare account${run.address ? ` (my Worker is ${run.address})` : ''}, so my team relay, phone link and invite links work.`,
    'Potato Workspace tried to do it by itself with wrangler. It made a working copy in its "worker-update" data folder with a wrangler.toml and the built Worker files.',
    '',
    `Steps that worked: ${done.length ? done.join(', ') : 'none'}.`,
    `The step that failed ${MAX_TRIES} times: ${failed ? labels[failed.id] : 'unknown'}.`,
    'What it printed:',
    output,
    '',
    'Please find out why, fix it, and tell me when it works. Ask me before anything that needs my Cloudflare password or a payment.',
  ].join('\n');
}

export async function loadAgentView(): Promise<AcpLaneView | null> {
  try {
    return await tauriAcpChatApi.laneGet();
  } catch {
    return null;
  }
}
