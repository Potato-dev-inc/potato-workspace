// The two registries: demo name -> component (demos/index.tsx), and action name -> handler (here).
// "Try it" runs a named action from a closed list; a card can never carry a URL or free text to run.
import { useEffect, useRef } from 'react';
import { openSettingsAt } from '../lib/openSettingsAt';
import type { SectionId } from '../components/settings/model';
import { OPEN_VIEW_EVENT } from './store';
import { ACTION_NAMES, type ActionName } from './types';

export const ACTION_EVENT = 'pm:whatsnew-action';

export type ActionArgs = Record<string, unknown>;
export type ActionHandler = (args: ActionArgs) => boolean | void;

const handlers = new Map<string, ActionHandler>();

/** The feature on screen that owns an action registers it for as long as it is mounted. */
export function useRegisterAction(name: ActionName, fn: ActionHandler, on = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    return registerAction(name, (args) => ref.current(args));
  }, [name, on]);
}

/** A feature registers what "Try it" does for its action. Returns the function that removes it. */
export function registerAction(name: ActionName, fn: ActionHandler): () => void {
  handlers.set(name, fn);
  return () => {
    if (handlers.get(name) === fn) handlers.delete(name);
  };
}

export const isActionName = (name: string): name is ActionName => (ACTION_NAMES as readonly string[]).includes(name);

// Built in: the pages every build has.
registerAction('settings.open', (args) => {
  const page = typeof args.page === 'string' ? args.page : 'general';
  openSettingsAt(page as SectionId);
});
registerAction('view.open', (args) => {
  const view = typeof args.view === 'string' ? args.view : 'inbox';
  window.dispatchEvent(new CustomEvent(OPEN_VIEW_EVENT, { detail: { view } }));
});

/**
 * Runs the action. `done`: a handler ran. Otherwise the action is announced on `pm:whatsnew-action` (a feature that
 * lives elsewhere in the app answers by setting `detail.handled`); `missing`: nobody ran it.
 */
export function runAction(action: ActionName, args: ActionArgs = {}): 'done' | 'missing' {
  const fn = handlers.get(action);
  if (fn) {
    // A handler that answers `false` says it could not do it here (no chat open, nothing to show): same as missing.
    return fn(args) === false ? 'missing' : 'done';
  }
  const detail = { action, args, handled: false };
  window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail }));
  return detail.handled ? 'done' : 'missing';
}
