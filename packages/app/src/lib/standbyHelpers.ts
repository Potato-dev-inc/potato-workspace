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
}

export interface StandbyHelpersApi {
  get: () => Promise<StandbyHelpersView | null>;
  add: (input: NewStandby) => Promise<StandbyHelpersView | null>;
  update: (id: string, patch: { name?: string; model?: string | null; after_task?: AfterTask }) => Promise<StandbyHelpersView | null>;
  remove: (id: string) => Promise<StandbyHelpersView | null>;
  start: (id: string) => Promise<StandbyHelpersView | null>;
  setLimits: (max: number, idleMinutes: number) => Promise<StandbyHelpersView | null>;
}

export const tauriStandbyHelpersApi: StandbyHelpersApi = {
  get: () => tauri.standbyHelpersGet(),
  add: (input) => tauri.standbyHelperAdd(input),
  update: (id, patch) => tauri.standbyHelperUpdate(id, patch),
  remove: (id) => tauri.standbyHelperRemove(id),
  start: (id) => tauri.standbyHelperStart(id),
  setLimits: (max, idleMinutes) => tauri.standbyHelpersSetLimits(max, idleMinutes),
};

export const EMPTY_STANDBY_VIEW: StandbyHelpersView = { helpers: [], max: 4, idle_minutes: 30 };

const POLL_MS = 3000;

/**
 * The standbys, kept fresh (every 3 s, and at once after a change made here). `apply` takes the view a change returned, so
 * the screen that made it does not wait for the next poll. The top bar and Settings both call this.
 */
export function useStandbyHelpers(api: StandbyHelpersApi = tauriStandbyHelpersApi): { view: StandbyHelpersView; loaded: boolean; apply: (next: StandbyHelpersView | null) => void } {
  const [view, setView] = useState<StandbyHelpersView | null>(null);
  useEffect(() => {
    let live = true;
    const pull = () => {
      api
        .get()
        .then((next) => live && next && setView(next))
        .catch(() => {});
    };
    pull();
    const timer = window.setInterval(pull, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [api]);
  return { view: view ?? EMPTY_STANDBY_VIEW, loaded: view !== null, apply: (next) => next && setView(next) };
}

/** The helpers bar's own type (`helper-standbys.ts`): only standbys that are waiting or working are drawn. */
export function toBarStandbys(helpers: readonly StandbyHelperEntry[]): Standby[] {
  return helpers.flatMap((h) => (h.state === 'ready' || h.state === 'busy' ? [{ id: h.id, agent: h.agent, name: h.name, model: h.model, state: h.state, project: h.project }] : []));
}

/** Keeps the top bar's list (`setStandbys`) in step with the backend. Call it once, high in the cockpit. */
export function useStandbyFeed(api: StandbyHelpersApi = tauriStandbyHelpersApi): void {
  const { view, loaded } = useStandbyHelpers(api);
  useEffect(() => {
    if (loaded) setStandbys(toBarStandbys(view.helpers));
  }, [view, loaded]);
}

/** Opens the "New standby helper" form (the dialog in the cockpit listens). `project`: the folder it starts with. */
export const NEW_STANDBY_EVENT = 'pm:new-standby';
export function openNewStandby(project?: string | null): void {
  window.dispatchEvent(new CustomEvent(NEW_STANDBY_EVENT, { detail: { project: project ?? null } }));
}
