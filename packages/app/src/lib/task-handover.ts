// Handing a background task (a minion) to a DIFFERENT agent. The person drags its row onto another agent in the sidebar, or
// uses "Hand to..." in the row menu; a small sheet then asks "Hand over now" or "Hand over when it finishes".
//   now           the task keeps running; the agent that started it stops getting its messages and result (it is told once);
//                 the new agent is told what it is and takes over its questions, its result and the right to stop it.
//   when_finished the first agent keeps it until it ends; then it moves and both agents get the result.
// The rules and the notices are the PC's (Rust `handover`). This file keeps the question that is open, and the call.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type HandMode = 'now' | 'when_finished';

/** What the sheet asks about. Names are the ones the person sees ("Claude 2"). */
export interface HandRequest {
  /** The minion's pane id. */
  taskPane: string;
  taskName: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
}

export interface HandOverApi {
  /** Resolves with a sentence to show when something did not go as planned (an agent could not be told), else ''. */
  handOver: (taskPane: string, toPane: string, mode: HandMode, names: Record<string, string>) => Promise<string>;
  /** Takes back "when it finishes" before it finished. */
  cancel: (taskPane: string) => Promise<boolean>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const call = <T>(command: string, args?: Record<string, unknown>): Promise<T> => (isTauri() ? invoke<T>(command, args) : Promise.reject(new Error(`Desktop shell required: ${command}`)));

export const tauriHandOverApi: HandOverApi = {
  handOver: (taskPane, toPane, mode, names) => call<string>('task_hand_over', { taskPane, toPane, mode, names }),
  cancel: (taskPane) => call<boolean>('task_hand_over_cancel', { taskPane }),
};

let open: HandRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Opens the sheet for this task and agent. Asking again replaces the question. */
export function askHandOver(req: HandRequest): void {
  if (req.fromId === req.toId) return;
  open = req;
  emit();
}

export function closeHandOver(): void {
  if (!open) return;
  open = null;
  emit();
}

/** The open question, or null. */
export const useHandOverRequest = (): HandRequest | null => useSyncExternalStore(subscribe, () => open);

/** Names in the shape the PC wants: keyed by pane id. */
export const namesOf = (req: HandRequest): Record<string, string> => ({ [req.taskPane]: req.taskName, [req.fromId]: req.fromName, [req.toId]: req.toName });
