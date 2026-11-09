import { useEffect } from 'react';
import { tauri } from '../lib/tauri';

/** Clicking through panes must not churn warm workers: only a folder that stays focused this long counts. */
export const FOLLOW_FOCUS_DEBOUNCE_MS = 2000;

/**
 * Tells the warm-agent pool which folder the person is working in (Settings > Preload "following").
 * `project` is the focused pane's project folder; null/undefined (nothing focused) says nothing.
 */
export function useFollowFocusedProject(
  project: string | null | undefined,
  send: (path: string) => unknown = (path) => tauri.standbySetCurrentProject(path),
): void {
  useEffect(() => {
    const path = project?.trim();
    if (!path) return;
    const timer = window.setTimeout(() => {
      try {
        void Promise.resolve(send(path)).catch(() => {});
      } catch {
        // The pool is a convenience; a failure here must never reach the pane.
      }
    }, FOLLOW_FOCUS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [project, send]);
}
