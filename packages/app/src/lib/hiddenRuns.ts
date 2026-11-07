// Helpers that ran with no pane (a hidden run). The Inbox lists them so a person can see that they ran.
// Backed by `hidden_runs_list` / `hidden_runs_dismiss` (the desktop window only).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';

export type HiddenRunStatus = 'running' | 'needs_input' | 'done' | 'failed' | 'cancelled';

export interface HiddenRun {
  handle: string;
  agent_type: string;
  task: string;
  project: string;
  status: HiddenRunStatus;
  started_at_ms: number;
  finished_at_ms: number | null;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface HiddenRunsApi {
  list: () => Promise<HiddenRun[]>;
  dismiss: (handle: string) => Promise<unknown>;
  /** Calls `onChange` whenever a hidden run starts, ends or is dismissed; returns how to stop. */
  watch: (onChange: () => void) => () => void;
}

export const tauriHiddenRunsApi: HiddenRunsApi = {
  list: async () => (isTauri() ? invoke<HiddenRun[]>('hidden_runs_list') : []),
  dismiss: async (handle) => (isTauri() ? invoke('hidden_runs_dismiss', { handle }) : false),
  watch: (onChange) => {
    if (!isTauri()) return () => undefined;
    let stop: (() => void) | null = null;
    let closed = false;
    void listen('hidden-runs://changed', onChange).then((off) => {
      if (closed) off();
      else stop = off;
    });
    return () => {
      closed = true;
      stop?.();
    };
  },
};

/** The hidden runs, kept current by the backend's change event. */
export function useHiddenRuns(api: HiddenRunsApi = tauriHiddenRunsApi): { runs: HiddenRun[]; dismiss: (handle: string) => void } {
  const [runs, setRuns] = useState<HiddenRun[]>([]);
  const refresh = useCallback(() => {
    api
      .list()
      .then(setRuns)
      .catch(() => undefined);
  }, [api]);
  useEffect(() => {
    refresh();
    return api.watch(refresh);
  }, [api, refresh]);
  const dismiss = useCallback(
    (handle: string) => {
      setRuns((all) => all.filter((r) => r.handle !== handle));
      void api.dismiss(handle).catch(() => undefined);
    },
    [api],
  );
  return { runs, dismiss };
}

/** One plain sentence for a row's state. */
export function hiddenRunState(run: HiddenRun): string {
  switch (run.status) {
    case 'running':
      return 'Running with no window';
    case 'needs_input':
      return 'Waiting for an answer';
    case 'done':
      return 'Finished';
    case 'failed':
      return 'Stopped with an error';
    case 'cancelled':
      return 'Cancelled';
  }
}
