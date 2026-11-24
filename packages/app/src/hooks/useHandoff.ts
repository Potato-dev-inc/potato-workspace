// "Handoff from here": one hook that both the sidebar (row menu) and the pane's top bar ("Hand off") use, so there is
// one starter and one "one at a time". The cockpit holds it once and passes it down.
import { useEffect, useRef, useState } from 'react';
import { listen } from '../lib/events';
import { DEFAULT_OPTIONS, realHandoffDeps, runHandoff, type HandoffDeps, type HandoffMode, type HandoffOptions, type HandoffStatus } from '../lib/handoff';
import { t } from '../i18n';
import { loadSettings } from '../lib/settings';
import type { CockpitApi } from './useCockpit';

export interface HandoffControl {
  /** Where it is: writing, opening, done or failed. Null before the first one and after Dismiss. */
  status: HandoffStatus | null;
  /** A handoff is running: no second one starts. */
  busy: boolean;
  /** What the button does now (Settings > Agents > Hand off does). The label follows it. */
  mode: HandoffMode;
  /** Plain shells have no conversation to hand over. */
  allowed: (paneId: string) => boolean;
  /** `with`: the calls of another place (a chat of another PC hands off through that PC's host); absent: this PC's own. */
  start: (paneId: string, withDeps?: HandoffDeps) => void;
  dismiss: () => void;
}

/** The two handoff settings, read when a handoff starts. Unreadable or missing: a new agent, no fixed notes. */
export async function readHandoffOptions(): Promise<HandoffOptions> {
  const settings = await loadSettings().catch(() => null);
  return { mode: settings?.handoff_mode === 'file' ? 'file' : 'new_agent', fixedNotes: settings?.handoff_fixed_notes ?? '' };
}

/** How long a failed handoff's line stays. */
const FAILED_SHOWN_MS = 10_000;

export function useHandoff(c: CockpitApi, deps?: HandoffDeps, readOptions: () => Promise<HandoffOptions> = readHandoffOptions): HandoffControl {
  const [status, setStatus] = useState<HandoffStatus | null>(null);
  const [mode, setMode] = useState<HandoffMode>(DEFAULT_OPTIONS.mode);
  const readRef = useRef(readOptions);
  readRef.current = readOptions;
  // The label follows the setting: read it now and whenever settings change.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    const read = () =>
      readRef
        .current()
        .then((o) => alive && setMode(o.mode))
        .catch(() => undefined);
    void read();
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      listen('settings://changed', () => void read())
        .then((u) => (alive ? (off = u) : u()))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  // A failure says its piece and goes: it must not sit in the sidebar for an hour.
  useEffect(() => {
    if (status?.kind !== 'failed') return;
    const timer = setTimeout(() => setStatus((s) => (s === status ? null : s)), FAILED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [status]);
  const busy = status?.kind === 'writing' || status?.kind === 'opening';
  const cRef = useRef(c);
  cRef.current = c;
  const start = (paneId: string, withDeps?: HandoffDeps) => {
    if (busy) return;
    const real =
      withDeps ??
      deps ??
      realHandoffDeps({
        pane: (id) => {
          const pane = cRef.current.registry.panes.get(id);
          return pane && { id, agentType: pane.info.agent_type, cwd: pane.info.cwd, lane: pane.info.lane as string | undefined, status: pane.status };
        },
        newAgent: (...args) => cRef.current.newAgent(...args),
        select: (id) => cRef.current.select(id),
        titleOf: (id) => cRef.current.names.get(id),
      });
    setStatus({ kind: 'writing', text: t('state.handoff.writing') });
    void readOptions().then((options) => runHandoff(paneId, real, setStatus, options));
  };
  const allowed = (id: string): boolean => {
    const type = c.registry.panes.get(id)?.info.agent_type;
    return !!type && !c.launchEntries.find((e) => e.type === type)?.shell;
  };
  return { status, busy, mode, allowed, start, dismiss: () => setStatus(null) };
}
