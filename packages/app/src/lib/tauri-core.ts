// Every `invoke` in the app (and in the Tauri plugins, and `listen`/`unlisten` inside the event module) resolves here instead of
// to the real package (see vite-tauri-core.ts). The real `invoke` is wrapped once: calls are counted and identical reads in
// flight are shared (lib/ipc-guard.ts). Tauri's own `window.__TAURI_INTERNALS__` is never touched.
import { invoke as realInvoke } from '@tauri-apps/api/core';
import { guardInvoke, pendingByCommand, pendingInvokes, queuedInvokes } from './ipc-guard';

export * from '@tauri-apps/api/core';
export const invoke = guardInvoke(realInvoke as never) as typeof realInvoke;

if (typeof window !== 'undefined') {
  const w = window as unknown as { __pendingInvokes?: () => number; __pendingByCommand?: typeof pendingByCommand; __queuedInvokes?: () => number };
  w.__pendingInvokes = pendingInvokes;
  w.__pendingByCommand = pendingByCommand;
  w.__queuedInvokes = queuedInvokes;
}
