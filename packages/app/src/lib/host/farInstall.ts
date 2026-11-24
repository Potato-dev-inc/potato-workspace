// Install an agent on ANOTHER PC (P6.2), through its host: the four `agents_install_*` rows of the far call table (`pclink/calls_install.rs`)
// run the same inner functions as this window's own Install. The far PC builds the plan, refuses a changed command and runs each step in
// a visible terminal pane there. This file only walks the plan: one step at a time, three tries per step, and says what it ended with.
// No React here; `components/devices/FarInstallSheet.tsx` draws it.
import { errorSentence } from '../sayError';
import type { AgentInstallApi, InstallFinish, InstallPlan, InstallStarted, InstallStatus, InstallStep } from '../agent-install';
import type { Host } from './host';

export const FAR_INSTALL_TRIES = 3;
/** How often a running step is asked whether its window's command has ended. */
export const FAR_INSTALL_POLL_MS = 1000;
/** A step that has not ended after this long is taken as failed (a stuck download; the window is still there to look at). */
const STEP_LIMIT_MS = 20 * 60 * 1000;

/** The far PC's own `agents_install_*` rows, as the same four verbs the window's Install uses. */
export function farInstallApi(host: Host): AgentInstallApi {
  return {
    plan: (agentId) => host.invoke<InstallPlan>('agents_install_plan', { agentId }),
    run: (agentId, step, shownCommand, acknowledgedRisk) => host.invoke<InstallStarted>('agents_install_run', { agentId, step, shownCommand, acknowledgedRisk }),
    status: (paneId) => host.invoke<InstallStatus>('agents_install_status', { paneId }),
    finish: (agentId) => host.invoke<InstallFinish>('agents_install_finish', { agentId }),
  };
}

/** Whether `agentId` is installed on that PC: its own health check (`agents_detect_installed`, Watch) names it. */
export async function installedOnFar(host: Host, agentId: string): Promise<boolean> {
  const found = await host.invoke<{ id: string }[]>('agents_detect_installed', {});
  return found.some((f) => f.id.toLowerCase() === agentId.toLowerCase());
}

/** The far PC's own verdict after an install: `agents_install_finish` (its PATH refreshed, its health check) and then the detect. */
export async function checkOnFar(host: Host, api: AgentInstallApi, agentId: string): Promise<boolean> {
  try {
    if ((await api.finish(agentId)).health.installed) return true;
  } catch {
    /* an agent the far PC lists only through its detect: the detect decides */
  }
  return installedOnFar(host, agentId);
}

export type StepProgress =
  | { kind: 'try'; index: number; attempt: number }
  | { kind: 'pane'; index: number; paneId: string }
  | { kind: 'done'; index: number };

export type FarInstallOutcome = { ok: true } | { ok: false; step: InstallStep; message: string };

export interface FarInstallDeps {
  api: AgentInstallApi;
  sleep: (ms: number) => Promise<void>;
  /** True once the person stopped it: no more steps start. */
  cancelled: () => boolean;
  report: (p: StepProgress) => void;
  /** Overridable so a test does not wait twenty minutes. */
  limitMs?: number;
}

/** Waits until the window's command has ended: its status, or `null` when stopped. */
async function waitForEnd(deps: FarInstallDeps, paneId: string): Promise<InstallStatus | null> {
  const until = (deps.limitMs ?? STEP_LIMIT_MS) / FAR_INSTALL_POLL_MS;
  for (let i = 0; i < until; i++) {
    if (deps.cancelled()) return null;
    const status = await deps.api.status(paneId);
    if (status.done || status.closed || !status.known) return status;
    await deps.sleep(FAR_INSTALL_POLL_MS);
  }
  return { known: true, done: false, exit_code: null, message: null };
}

/**
 * Runs every step of `plan` on the far PC in order, each up to `FAR_INSTALL_TRIES` times. A step passes when its window printed exit 0.
 * Returns the first step that failed all its tries, with the last reason in plain words; the caller hands over to the person then.
 * `acknowledgedRisk` is the second yes for a downloaded script (the far PC refuses a script step without it).
 */
export async function runFarInstall(agentId: string, plan: InstallPlan, acknowledgedRisk: boolean, deps: FarInstallDeps): Promise<FarInstallOutcome | 'stopped'> {
  for (let index = 0; index < plan.steps.length; index++) {
    const step = plan.steps[index];
    let message = '';
    let passed = false;
    for (let attempt = 1; attempt <= FAR_INSTALL_TRIES && !passed; attempt++) {
      if (deps.cancelled()) return 'stopped';
      deps.report({ kind: 'try', index, attempt });
      try {
        const started = await deps.api.run(agentId, step.index, step.command, step.high_risk && acknowledgedRisk);
        deps.report({ kind: 'pane', index, paneId: started.pane_id });
        const status = await waitForEnd(deps, started.pane_id);
        if (!status) return 'stopped';
        if (status.done && status.exit_code === 0) passed = true;
        else message = status.closed ? 'The install window was closed before it finished.' : (status.message ?? 'The install did not finish.');
      } catch (error) {
        message = errorSentence(error).replace(/^[A-Z_]+: /, '');
      }
      if (!passed && attempt < FAR_INSTALL_TRIES) await deps.sleep(FAR_INSTALL_POLL_MS);
    }
    if (!passed) return { ok: false, step, message };
    deps.report({ kind: 'done', index });
  }
  return { ok: true };
}
