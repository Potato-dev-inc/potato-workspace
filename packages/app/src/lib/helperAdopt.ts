// "Make helper of...": drag one main agent onto another in the sidebar (or use the row menu) and it becomes that agent's
// helper; "Make it a main agent again" takes it back. These are the rules (pure, so every refusal is easy to test) and the
// one call to the desktop shell. The shell checks the shape again (no loops, nothing missing); the project rule lives here
// because only the sidebar knows how folders and copies group into projects.
import { invoke } from '@tauri-apps/api/core';
import type { MessageKey } from '../i18n';

/** What the rules need to know about an agent. */
export interface AdoptPane {
  id: string;
  /** The agent it is a helper of; empty for a main agent. */
  parent: string | null;
  /** The project it is listed under (the sidebar's grouping key). */
  project: string;
}

/** The sentence key of a refusal, or null when `child` may become a helper of `parent`. */
export function adoptRefusal(child: AdoptPane | undefined, parent: AdoptPane | undefined, all: readonly AdoptPane[]): MessageKey | null {
  if (!child || !parent) return 'adopt.gone';
  if (child.id === parent.id) return 'adopt.self';
  // Is the target one of the dragged agent's own helpers (anywhere below it)?
  const byId = new Map(all.map((p) => [p.id, p]));
  let at: AdoptPane | undefined = parent;
  for (let i = 0; at && i < 16; i++) {
    if (at.parent === child.id) return 'adopt.loop';
    at = at.parent ? byId.get(at.parent) : undefined;
  }
  if (child.parent) return 'adopt.isHelper';
  if (parent.parent) return 'adopt.targetHelper';
  if (child.project !== parent.project) return 'adopt.noProject';
  return null;
}

/** The main agents `child` could become a helper of (for the row menu), in list order. */
export function adoptTargets(child: AdoptPane | undefined, all: readonly AdoptPane[]): AdoptPane[] {
  if (!child || child.parent) return [];
  return all.filter((p) => p.id !== child.id && adoptRefusal(child, p, all) === null);
}

/** What the sidebar needs from the desktop shell (a fake in tests). */
export interface AdoptApi {
  /** Makes `paneId` a helper of `parentId`, or a main agent again with `null`. Rejects with a plain sentence. */
  setHelperOf: (paneId: string, parentId: string | null) => Promise<void>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const tauriAdoptApi: AdoptApi = {
  setHelperOf: (paneId, parentId) => (isTauri() ? invoke<void>('pane_set_helper_of', { paneId, parentId }) : Promise.reject(new Error('Desktop shell required: pane_set_helper_of'))),
};
