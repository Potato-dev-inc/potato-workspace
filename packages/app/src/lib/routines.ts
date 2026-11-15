// Routines and Chains on the desktop: the view shapes (mirroring `routines/view.rs`, camelCase), the `routines_*`
// commands (`commands/routines.rs`), the events and the hooks. Names and argument keys must match the Rust code
// exactly (`routines.test.ts` checks them against the command file). A workflow is saved as versioned JSON; the
// `NewWorkflow` shape below is the same JSON the engine stores, so a node editor can build it later.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sayError } from './sayError';

export const ROUTINES_CHANGED = 'routines://changed';
export const ROUTINES_NOTICE = 'routines://notice';

/** Days are 1 (Monday) to 7 (Sunday); an empty list means every day. */
export type Trigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; days: number[]; time: string }
  | { kind: 'chat_finished'; pane_id: string; only_if_ok: boolean };

export type Step =
  | { kind: 'start_agent'; agent: string; project: string; task: string; separate_copy: boolean }
  | { kind: 'wait' }
  | { kind: 'follow_up'; text: string }
  | { kind: 'notify'; text: string };

/** What the person fills in (`NewWorkflow`). */
export interface NewWorkflow {
  name: string;
  trigger: Trigger;
  steps: Step[];
}

export interface StepView {
  kind: 'start_agent' | 'wait' | 'follow_up' | 'notify';
  agent: string | null;
  project: string | null;
  text: string | null;
  separateCopy: boolean;
}

export type WorkflowKind = 'routine' | 'chain' | 'manual';
/** Why a workflow is off (`paused_note`). */
export type PausedNote = 'paused_failed' | 'chat_gone' | 'not_ok' | 'ran_once';

export interface WorkflowView {
  id: string;
  name: string;
  kind: WorkflowKind;
  enabled: boolean;
  days: number[];
  time: string | null;
  paneId: string | null;
  onlyIfOk: boolean;
  steps: StepView[];
  nextMs: number | null;
  lastRunMs: number | null;
  lastResult: string | null;
  pausedNote: PausedNote | null;
  running: boolean;
}

export type RunStateTag = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'skipped';

export interface RunView {
  id: string;
  workflowId: string;
  name: string;
  state: RunStateTag;
  step: number;
  stepCount: number;
  noteCode: string | null;
  noteDetail: string | null;
  dueMs: number | null;
  createdMs: number;
  finishedMs: number | null;
}

export interface QueueRow {
  runId: string;
  name: string;
  /** 1 is next. */
  position: number;
}

export interface RoutinesView {
  /** "At most N at once": null is off. */
  limit: number | null;
  /** Agents running now. */
  running: number;
  workflows: WorkflowView[];
  queue: QueueRow[];
  runs: RunView[];
}

export interface RoutineAgent {
  id: string;
  label: string;
}

export const EMPTY_VIEW: RoutinesView = { limit: null, running: 0, workflows: [], queue: [], runs: [] };

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const routinesApi = {
  view: () => invoke<RoutinesView>('routines_view'),
  agents: () => invoke<RoutineAgent[]>('routines_agents'),
  create: (workflow: NewWorkflow) => invoke<string>('routines_create', { workflow }),
  setEnabled: (id: string, enabled: boolean) => invoke<void>('routines_set_enabled', { id, enabled }),
  remove: (id: string) => invoke<void>('routines_delete', { id }),
  runNow: (id: string) => invoke<string>('routines_run_now', { id }),
  stopRun: (runId: string) => invoke<void>('routines_stop_run', { runId }),
  setLimit: (limit: number | null) => invoke<void>('routines_set_limit', { limit }),
};

/** A command failure as one sentence for the screen (the engine's own sentences pass through). */
export function routinesError(error: unknown): string {
  return sayError(error).text;
}

/** The page's data, kept current: read on open, on `routines://changed`, and every 15 seconds (the clock moves). */
export function useRoutines(): { view: RoutinesView; ready: boolean; error: string | null; reload: () => void } {
  const [view, setView] = useState<RoutinesView>(EMPTY_VIEW);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const reload = useCallback(() => {
    if (!inTauri()) {
      setReady(true);
      return;
    }
    Promise.resolve()
      .then(() => routinesApi.view())
      .then((next) => {
        if (!alive.current) return;
        setView(next);
        setError(null);
        setReady(true);
      })
      .catch((e) => {
        if (!alive.current) return;
        setError(routinesError(e));
        setReady(true);
      });
  }, []);
  useEffect(() => {
    alive.current = true;
    reload();
    let off: UnlistenFn | undefined;
    if (inTauri()) {
      listen(ROUTINES_CHANGED, reload)
        .then((u) => (alive.current ? (off = u) : u()))
        .catch(() => {});
    }
    const timer = window.setInterval(reload, 15_000);
    return () => {
      alive.current = false;
      off?.();
      window.clearInterval(timer);
    };
  }, [reload]);
  return { view, ready, error, reload };
}

/** A routine or chain tells the person something (a `notify` step, a failure, a pause): show it as a notice. */
export function useRoutineNotices(notify: (text: string) => void): void {
  const latest = useRef(notify);
  latest.current = notify;
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let off: UnlistenFn | undefined;
    listen<{ text: string; problem: boolean }>(ROUTINES_NOTICE, (event) => {
      if (event.payload?.text) latest.current(event.payload.text);
    })
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
}

/** The steps a routine form makes: start an agent, wait for it, tell the person. */
export function routineSteps(input: { agent: string; project: string; task: string; separateCopy: boolean; notify: boolean; notifyText: string }): Step[] {
  const steps: Step[] = [
    { kind: 'start_agent', agent: input.agent, project: input.project, task: input.task.trim(), separate_copy: input.separateCopy },
    { kind: 'wait' },
  ];
  if (input.notify) steps.push({ kind: 'notify', text: input.notifyText });
  return steps;
}
