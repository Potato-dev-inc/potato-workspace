// "Show terminals" (Settings > General). OFF by default: every place that starts an agent starts a chat, agents that can
// only run in a terminal are not offered, and terminal-only controls are hidden. Open terminals keep working: this
// decides what the app OFFERS, never what is running. Rust twin: `show_terminals.rs` (the phone's new-chat route).
//
// The desktop window reads the saved setting and follows `settings://changed`. Without a desktop shell (a plain browser,
// the unit tests) there is no setting to read, so terminals are shown: that is "today", and every older test keeps
// working. A test that wants the OFF state calls `forceShowTerminals(false)`.
import { useEffect, useSyncExternalStore } from 'react';

export interface TerminalSwitchSettings {
  show_terminals?: boolean | null;
  acp_chat_enabled?: boolean | null;
}

/**
 * Whether terminals are offered. On when the person turned "Show terminals" on, or when Chat itself is off (then no chat can
 * start, and hiding the terminal would leave nothing to start). Absent means off.
 */
export function terminalsShown(settings: TerminalSwitchSettings | null | undefined): boolean {
  if (!settings) return false;
  if (settings.show_terminals === true) return true;
  return settings.acp_chat_enabled === false;
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let current: boolean | null = null; // the last value read from the setting; null: not read yet
let forced: boolean | null = null; // a test's value
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

function set(next: boolean): void {
  if (current === next) return;
  current = next;
  emit();
}

/** Tests: pretend the setting is `value`; `null` goes back to reading it. */
export function forceShowTerminals(value: boolean | null): void {
  forced = value;
  emit();
}

function snapshot(): boolean {
  if (forced !== null) return forced;
  if (!inTauri()) return true;
  return current ?? false; // not read yet: hide, so a terminal control never flashes on and off
}

/** Reads the setting once and again whenever Settings change. */
export function useShowTerminals(): boolean {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    snapshot,
  );
  useEffect(() => {
    if (forced !== null || !inTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    // Loaded on use, so importing this file costs nothing (and a test that mocks the settings module still wins).
    const read = () =>
      import('./settings')
        .then(({ loadSettings }) => loadSettings())
        .then((s) => !disposed && set(terminalsShown(s as TerminalSwitchSettings)))
        .catch(() => undefined);
    void read();
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('settings://changed', () => void read()))
      .then((stop) => (disposed ? stop() : (off = stop)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return value;
}
