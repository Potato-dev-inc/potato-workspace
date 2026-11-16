// Standby helpers: helpers the person makes themselves (agent + model + project + name), started ahead of time and waiting
// with no tokens used. The next matching task uses one. Backed by `standby::helpers` (Rust) and the warm chat pool.
//
// ONE shape for every screen. Settings > Agents > Standby helpers and the top bar's "Ready" chips both read
// `StandbyHelperEntry` (from `useStandbyHelpers()`), so a change made in one shows in the other at once.
import { useEffect, useState } from 'react';
import { setStandbys, type Standby } from './helper-standbys';
import { tauri } from './tauri';

/** `ready` waiting for a task; `busy` a task is running on it (its chat is `pane_id`); `starting`; `asleep` closed to save
 * memory, starts when a task asks or on "Start"; `problem` could not start (`note` says why). */
export type StandbyState = 'ready' | 'busy' | 'starting' | 'asleep' | 'problem';
/** What it does when its task is over: `wait` starts again and waits; `close` stays closed until it is needed. */
export type AfterTask = 'wait' | 'close';
/** Why an agent's task passed a standby by: a different model, another project, busy, or the person was using it. */
export type SkipReason = 'different_model' | 'other_project' | 'busy' | 'you_were_using_it';
/** Why a standby is a problem. */
export type StandbyNote = 'needs_chat' | 'folder_missing' | 'did_not_start' | 'needs_sign_in';

export interface StandbyHelperEntry {
  id: string;
  name: string;
  agent: string;
  model: string | null;
  project: string;
  after_task: AfterTask;
  state: StandbyState;
  note: StandbyNote | string | null;
  /** The chat doing the task while `state` is `busy`. The top bar moves the chip next to that chat's helpers. */
  pane_id: string | null;
  /** How many times an agent's task used it today (the person's local day; starts again at local midnight). */
  used_today?: number;
  /** The last reason an agent's task passed it by. Memory only; a restart clears it. */
  skip_reason?: SkipReason | null;
  /** The pane id of the agent the helper is shown under (the project owns it). `null`: the screens choose. */
  home: string | null;
  /** While `busy`: an agent's task (`agent`) or the person using it (`person`). */
  used_by: 'agent' | 'person' | null;
  /** An agent took it over while the person was using it. */
  taken_over: boolean;
  /** The chat the person has open on this helper (Ready or With you). It is drawn as the helper's row, not as an agent. */
  open_pane: string | null;
  /** While `taken_over`: the person's chat whose turn was stopped. The banner and the draft live there. */
  person_pane: string | null;
  /** A free warm agent: it was removed from its agent and keeps running. Not drawn under an agent. */
  warm?: boolean;
  /** While `starting`: where the start is (`starting program`, `connecting`, `opening session`, `setting model`). */
  stage?: string | null;
  /** How long the start has been at that stage (ms), as of the last read. */
  stage_ms?: number | null;
}

export interface StandbyHelpersView {
  helpers: StandbyHelperEntry[];
  /** Most standbys at once. */
  max: number;
  /** A standby nobody used for this many minutes is closed to free memory. */
  idle_minutes: number;
}

/** Standbys for one project (the top bar shows the ones for the project in front). Same folder in any spelling. */
export function standbysForProject(helpers: readonly StandbyHelperEntry[], project: string | null | undefined): StandbyHelperEntry[] {
  if (!project) return [];
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return helpers.filter((h) => norm(h.project) === norm(project));
}

/** The standby whose task runs in chat `paneId`, if any. */
export const standbyForPane = (helpers: readonly StandbyHelperEntry[], paneId: string): StandbyHelperEntry | undefined => helpers.find((h) => h.state === 'busy' && h.pane_id === paneId);

export interface NewStandby {
  name: string;
  agent: string;
  model: string | null;
  project: string;
  after_task: AfterTask;
  home?: string | null;
}

export interface StandbyHelpersApi {
  get: () => Promise<StandbyHelpersView | null>;
  add: (input: NewStandby) => Promise<StandbyHelpersView | null>;
  update: (id: string, patch: { name?: string; model?: string | null; after_task?: AfterTask; home?: string | null }) => Promise<StandbyHelpersView | null>;
  remove: (id: string) => Promise<StandbyHelpersView | null>;
  /** "Remove from the agent": it keeps running as a free warm agent. */
  detach: (id: string) => Promise<StandbyHelpersView | null>;
  start: (id: string) => Promise<StandbyHelpersView | null>;
  setLimits: (max: number, idleMinutes: number) => Promise<StandbyHelpersView | null>;
  /** Opens the helper as a chat; resolves with that chat's pane id. */
  open: (id: string) => Promise<string | null>;
  /** "Stop the task and take it back". */
  takeBack: (id: string) => Promise<StandbyHelpersView | null>;
}

export const tauriStandbyHelpersApi: StandbyHelpersApi = {
  get: () => tauri.standbyHelpersGet(),
  add: (input) => tauri.standbyHelperAdd(input),
  update: (id, patch) => tauri.standbyHelperUpdate(id, patch),
  remove: (id) => tauri.standbyHelperRemove(id),
  detach: (id) => tauri.standbyHelperDetach(id),
  start: (id) => tauri.standbyHelperStart(id),
  setLimits: (max, idleMinutes) => tauri.standbyHelpersSetLimits(max, idleMinutes),
  open: (id) => tauri.standbyHelperOpen(id),
  takeBack: (id) => tauri.standbyHelperTakeBack(id),
};

export const EMPTY_STANDBY_VIEW: StandbyHelpersView = { helpers: [], max: 4, idle_minutes: 30 };

const POLL_MS = 3000;
const FAST_POLL_MS = 1000;

// One shared copy of the list per api object: the sidebar, the popover, the chat banner and Settings all read it, and only one
// timer asks the backend (3 s) while any of them is on screen.
interface Shared {
  view: StandbyHelpersView | null;
  listeners: Set<() => void>;
  timer: number | null;
  live: boolean;
  /** A one-second look is already planned (a start is going on). */
  fast: boolean;
}
const shared = new WeakMap<StandbyHelpersApi, Shared>();
function sharedFor(api: StandbyHelpersApi): Shared {
  let s = shared.get(api);
  if (!s) {
    s = { view: null, listeners: new Set(), timer: null, live: false, fast: false };
    shared.set(api, s);
  }
  return s;
}
const setShared = (s: Shared, next: StandbyHelpersView | null) => {
  if (!next) return;
  s.view = next;
  for (const l of s.listeners) l();
};

/**
 * The standbys, kept fresh (every 3 s, and at once after a change made here). `apply` takes the view a change returned, so
 * the screen that made it does not wait for the next poll. The sidebar, the popover, the chat banner and Settings all call this.
 */
export function useStandbyHelpers(api: StandbyHelpersApi = tauriStandbyHelpersApi): { view: StandbyHelpersView; loaded: boolean; apply: (next: StandbyHelpersView | null) => void } {
  const [, tick] = useState(0);
  useEffect(() => {
    const s = sharedFor(api);
    const listener = () => tick((n) => n + 1);
    s.listeners.add(listener);
    const pull = () => {
      Promise.resolve()
        .then(() => api.get())
        .then((next) => {
          if (s.listeners.size === 0) return;
          setShared(s, next);
          // A start is going on: look again in a second, so the row's stage words (Connecting, Opening session...) keep up.
          if (!s.fast && next?.helpers.some((h) => h.state === 'starting')) {
            s.fast = true;
            window.setTimeout(() => {
              s.fast = false;
              pull();
            }, FAST_POLL_MS);
          }
        })
        .catch(() => {});
    };
    if (s.timer === null) {
      pull();
      s.timer = window.setInterval(pull, POLL_MS);
    }
    if (s.view) listener();
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size === 0 && s.timer !== null) {
        window.clearInterval(s.timer);
        s.timer = null;
      }
    };
  }, [api]);
  const s = sharedFor(api);
  return { view: s.view ?? EMPTY_STANDBY_VIEW, loaded: s.view !== null, apply: (next) => setShared(s, next) };
}

/** The helpers bar's own type (`helper-standbys.ts`): a standby that is waiting, working or starting again is drawn, so a chip
 * never vanishes while a task has it or while it fills up again. (Closed to save memory, and could-not-start, are Settings' business.) */
export function toBarStandbys(helpers: readonly StandbyHelperEntry[]): Standby[] {
  return helpers.flatMap((h) => (h.state === 'ready' || h.state === 'busy' || h.state === 'starting' ? [{ id: h.id, agent: h.agent, name: h.name, model: h.model, state: h.state, project: h.project }] : []));
}

/** Keeps the top bar's list (`setStandbys`) in step with the backend. Call it once, high in the cockpit. */
export function useStandbyFeed(api: StandbyHelpersApi = tauriStandbyHelpersApi): void {
  const { view, loaded } = useStandbyHelpers(api);
  useEffect(() => {
    if (loaded) setStandbys(toBarStandbys(view.helpers));
  }, [view, loaded]);
}

/** Opens the "Add a helper" popover (the cockpit listens). `project`: the folder; `home`: the agent's pane it goes under;
 * `anchor`: where the popover sits (a point near the agent's row). */
export const NEW_STANDBY_EVENT = 'pm:new-standby';
export interface NewStandbyRequest {
  project: string | null;
  home: string | null;
  anchor: { x: number; y: number } | null;
}
export function openNewStandby(project?: string | null, home?: string | null, anchor?: { x: number; y: number } | null): void {
  const detail: NewStandbyRequest = { project: project ?? null, home: home ?? null, anchor: anchor ?? null };
  window.dispatchEvent(new CustomEvent(NEW_STANDBY_EVENT, { detail }));
}

/** Timing marks for a click on a standby row (`standby:click`, `standby:selected`), read with `performance.getEntriesByType('mark')`
 * in a debug session. The pane is meant to show in under 300 ms. Never throws; records only a name and the time. */
export function markStandbyOpen(stage: 'click' | 'selected'): void {
  try {
    performance.clearMarks(`standby:${stage}`);
    performance.mark(`standby:${stage}`);
  } catch {
    // no performance API: nothing to record
  }
}
