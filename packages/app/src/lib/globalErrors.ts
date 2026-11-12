// Catches what no screen caught: an uncaught error and a rejected promise nobody handled. Each one goes to the
// app log through the `log_ui_error` command (another module adds that command; until it exists the call is a
// quiet no-op). At most 20 a minute, so a loop of failures cannot flood the log.
import { invoke } from '@tauri-apps/api/core';

export const MAX_UI_ERRORS_PER_MINUTE = 20;
const WINDOW_MS = 60_000;
const MAX_TEXT = 2000;

export interface UiErrorReport {
  where: string;
  message: string;
  stack: string;
}

type Send = (report: UiErrorReport) => Promise<unknown>;

const isTauriRuntime = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const defaultSend: Send = (report) => (isTauriRuntime() ? invoke('log_ui_error', { ...report }) : Promise.resolve());

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text);

/** The log fields for any thrown value. */
export function describeThrown(value: unknown): { message: string; stack: string } {
  if (value instanceof Error) return { message: clip(value.message), stack: clip(value.stack ?? '') };
  if (typeof value === 'string') return { message: clip(value), stack: '' };
  try {
    return { message: clip(JSON.stringify(value) ?? String(value)), stack: '' };
  } catch {
    return { message: 'Unreadable error value', stack: '' };
  }
}

/** A sender that lets `limit` reports through in any `windowMs`, and drops the rest. */
export function createReporter(send: Send = defaultSend, now: () => number = Date.now, limit = MAX_UI_ERRORS_PER_MINUTE) {
  let times: number[] = [];
  return function report(where: string, value: unknown, extraStack = ''): boolean {
    const t = now();
    times = times.filter((x) => t - x < WINDOW_MS);
    if (times.length >= limit) return false;
    times.push(t);
    const { message, stack } = describeThrown(value);
    const merged = clip([stack, extraStack].filter(Boolean).join('\n'));
    try {
      // A missing command or a closed channel is fine: logging must never raise an error of its own.
      void send({ where, message, stack: merged }).catch(() => undefined);
    } catch {
      /* ignore */
    }
    return true;
  };
}

const shared = createReporter();

/** For the error boundary and any catch block that wants its error in the log. */
export function reportUiError(where: string, value: unknown, extraStack = ''): boolean {
  return shared(where, value, extraStack);
}

/** Starts listening on the window. Returns a function that stops. Call once per window. */
export function installGlobalErrorHandlers(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window, report = reportUiError): () => void {
  const onError = (event: Event): void => {
    const e = event as ErrorEvent;
    report('window.onerror', e.error ?? e.message ?? 'Unknown error');
  };
  const onRejection = (event: Event): void => {
    report('unhandledrejection', (event as PromiseRejectionEvent).reason);
  };
  if (typeof target?.addEventListener !== 'function') return () => undefined;
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
