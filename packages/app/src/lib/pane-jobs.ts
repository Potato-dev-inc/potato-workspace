// Background jobs: the long-lived processes an agent left running inside a pane (a dev server, a
// watcher, a background shell). Backend: `pane_jobs_all` / `pane_job_stop` (src-tauri pane_jobs/).
// One poll serves every card and chip on screen: it runs every 3 s while something listens and the
// window is visible, and stops when nothing does.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { formatElapsed } from '../components/cockpit/model';
import { t } from '../i18n';

export interface PaneJob {
  /** The process to stop; its whole tree goes with it. */
  pid: number;
  parentPid: number;
  name: string;
  /** Short command line, already redacted. */
  command: string;
  startedAtMs: number;
  ports: number[];
  /** Where it was found: the process tree, a terminal the app hosts for the agent, or only the chat's own tool calls. */
  source?: 'process' | 'terminal' | 'chat';
  /** What the command does, for a plain name when the agent gave none. */
  kind?: 'test' | 'build' | 'dev' | 'install' | 'other';
  /** The name the agent gave it (`start_terminal`). */
  title?: string;
  terminalId?: string;
  callId?: string;
  /** The app can stop it (it has a process it may end, or it is a terminal). Left out: yes. */
  stoppable?: boolean;
}

/** A command that is over. */
export interface FinishedCommand {
  id: string;
  name: string;
  command: string;
  kind?: PaneJob['kind'];
  title?: string;
  startedAtMs: number;
  endedAtMs: number;
  state: 'done' | 'failed' | 'stopped';
  exitCode?: number;
  terminalId?: string;
  stoppedBy?: string;
}

/** Finished commands per owner pane (newest first). */
export type FinishedMap = Record<string, FinishedCommand[]>;

/** What a terminal's output view reads. */
export interface TerminalOutput {
  lines: string[];
  nextCursor: number;
  state: 'running' | 'exited' | 'stopped';
  exitCode?: number;
  ports?: number[];
  partialLine?: string;
}

/** A stable key for a row: a terminal's id, the chat call's id, or the process and when it started. */
export const jobKey = (job: PaneJob): string => (job.terminalId ? `t:${job.terminalId}` : job.callId && !job.pid ? `c:${job.callId}` : `p:${job.pid}:${job.startedAtMs}`);

/** Whether Stop can end it. */
export const canStop = (job: PaneJob): boolean => job.stoppable !== false;

/** Jobs per pane id; panes with none are left out. */
export type JobsMap = Record<string, PaneJob[]>;

export const POLL_MS = 3000;

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface JobsApi {
  all: () => Promise<JobsMap>;
  /** `startedAtMs` is the job's own start time: the backend stops the pid only while it is still that process. */
  stop: (paneId: string, pid: number, startedAtMs: number) => Promise<void>;
  /** The last finished commands per owner pane. */
  finished?: () => Promise<FinishedMap>;
  /** Stops a terminal an agent started (its whole tree). */
  stopTerminal?: (terminalId: string) => Promise<void>;
  /** A terminal's output, read only. `afterCursor` asks for what came after the last read. */
  output?: (terminalId: string, afterCursor?: number) => Promise<TerminalOutput>;
}

interface RawOutput {
  lines?: string[];
  next_cursor?: number;
  state?: TerminalOutput['state'];
  exit_code?: number;
  ports?: number[];
  partial_line?: string;
}

export const tauriJobsApi: JobsApi = {
  all: async () => (inTauri() ? invoke<JobsMap>('pane_jobs_all') : {}),
  stop: (paneId, pid, startedAtMs) => invoke<void>('pane_job_stop', { paneId, pid, startedAtMs }),
  finished: async () => (inTauri() ? invoke<FinishedMap>('pane_jobs_finished') : {}),
  stopTerminal: (terminalId) => invoke<void>('agent_terminal_stop', { terminalId }),
  output: async (terminalId, afterCursor) => {
    const raw = await invoke<RawOutput>('agent_terminal_output', { terminalId, afterCursor });
    return { lines: raw.lines ?? [], nextCursor: raw.next_cursor ?? 0, state: raw.state ?? 'running', exitCode: raw.exit_code, ports: raw.ports, partialLine: raw.partial_line };
  },
};

/** "12m", "3h 5m": how long a job has run. */
export const runTime = (startedAtMs: number, now: number): string => formatElapsed(now - startedAtMs);

export const jobCount = (map: JobsMap): number => Object.values(map).reduce((sum, list) => sum + list.length, 0);

/**
 * The jobs of panes that are in the sidebar's list. The footer chip and the sidebar's "No agents running" both read
 * this one list of panes, so a job left behind by a closed pane is not counted as running.
 */
export function jobsOfPanes(map: JobsMap, paneIds: Iterable<string>): JobsMap {
  const live = new Set(paneIds);
  return Object.fromEntries(Object.entries(map).filter(([id, list]) => live.has(id) && list.length > 0));
}

/** "1 background task", "3 background tasks": the processes agents left running, not agents. */
export const jobsRunning = (n: number): string => t('state.jobs.count', { count: n });

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// --- the shared poll ---------------------------------------------------------------------------
let current: JobsMap = {};
let currentFinished: FinishedMap = {};
const listeners = new Set<(map: JobsMap) => void>();
const finishedListeners = new Set<(map: FinishedMap) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
let api: JobsApi = tauriJobsApi;

async function refresh(): Promise<void> {
  if (busy || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
  busy = true;
  try {
    const next = (await api.all()) ?? {};
    if (!same(current, next)) {
      current = next;
      listeners.forEach((fn) => fn(next));
    }
    if (finishedListeners.size > 0 && api.finished) {
      const done = (await api.finished()) ?? {};
      if (!same(currentFinished, done)) {
        currentFinished = done;
        finishedListeners.forEach((fn) => fn(done));
      }
    }
  } catch {
    // The next tick asks again.
  } finally {
    busy = false;
  }
}

/** Ask now (after a stop), without waiting for the next tick. */
export const refreshJobs = (): Promise<void> => refresh();

/** The finished commands per pane (read with the same shared poll). `source` is for tests. */
export function useFinishedCommands(source: JobsApi = tauriJobsApi): FinishedMap {
  const [map, setMap] = useState<FinishedMap>(currentFinished);
  useEffect(() => {
    api = source;
    finishedListeners.add(setMap);
    setMap(currentFinished);
    void refresh();
    return () => {
      finishedListeners.delete(setMap);
      if (finishedListeners.size === 0) currentFinished = {};
    };
  }, [source]);
  return map;
}

/** All jobs per pane. `source` is for tests. */
export function usePaneJobs(source: JobsApi = tauriJobsApi): JobsMap {
  const [map, setMap] = useState<JobsMap>(current);
  useEffect(() => {
    api = source;
    listeners.add(setMap);
    setMap(current);
    if (listeners.size === 1) {
      void refresh();
      timer = setInterval(() => void refresh(), POLL_MS);
    } else void refresh();
    return () => {
      listeners.delete(setMap);
      if (listeners.size === 0) {
        if (timer) clearInterval(timer);
        timer = undefined;
        current = {};
      }
    };
  }, [source]);
  return map;
}
