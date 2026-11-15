// The Team shelf: skills and tools the person has, what teammates suggest, and the one-click add.
//
// The Rust side (src-tauri/src/team/shelf) holds everything; this file is the typed command surface. Everything a
// teammate sent (names, the "why" line, skill text, command lines) is untrusted: the screens show it as plain text only,
// never as HTML or Markdown, never inside a link, and nothing here runs or adds anything by itself.
import { invoke } from '@tauri-apps/api/core';

export type ShelfKind = 'skill' | 'tool' | 'unknown';

export interface ShelfTarget {
  id: string;
  label: string;
  installed: boolean;
  tools: boolean;
  skills: boolean;
}

/** What an item would run or contact, and why it needs a tick first. */
export interface ShelfRisk {
  shown: string;
  needsTrust: boolean;
  reasons: string[];
}

export interface MineView {
  id: string;
  kind: ShelfKind;
  name: string;
  about: string;
  source: string;
  agents: string[];
  shareable: boolean;
  reason: string | null;
  needs: string[];
  shown: string;
  skippedFiles: number;
  have: string[];
  suggested: boolean;
}

export interface CardView {
  cardId: string;
  id: string;
  kind: ShelfKind;
  name: string;
  about: string;
  by: string;
  byName: string;
  why: string;
  atMs: number;
  everyone: boolean;
  needs: string[];
  shown: string;
  risk: ShelfRisk | null;
  skippedFiles: number;
  unknown: boolean;
  here: boolean;
  have: string[];
}

export interface Recommended {
  id: string;
  cardId: string;
  kind: ShelfKind;
  name: string;
  about: string;
  byNames: string[];
  have: string[];
  here: boolean;
  unknown: boolean;
  needs: string[];
  shown: string;
  risk: ShelfRisk | null;
}

export interface ShelfPerson {
  id: string;
  name: string;
}

export interface ShelfState {
  targets: ShelfTarget[];
  mine: MineView[];
  suggested: CardView[];
  recommended: Recommended[];
  people: ShelfPerson[];
  teamSize: number;
  waiting: number;
}

export type WriteStatus = 'add' | 'unchanged' | 'conflict' | 'skipped' | 'error';

export interface ShelfWrite {
  kind: 'tool' | 'skill';
  agents: { id: string; label: string }[];
  path: string;
  status: WriteStatus;
  reason: string | null;
  text: string;
}

export interface ShelfPreview {
  id: string;
  name: string;
  kind: ShelfKind;
  risk: ShelfRisk | null;
  needs: string[];
  skippedFiles: number;
  writes: ShelfWrite[];
  canAdd: boolean;
  blocked: string | null;
}

export interface ShelfApplied {
  id: string;
  name: string;
  kind: ShelfKind;
  addedTo: string[];
  agentIds: string[];
  writes: ShelfWrite[];
  undo: string | null;
}

export interface ShelfUndone {
  restored: number;
  skipped: string[];
}

export interface ShelfApi {
  state: () => Promise<ShelfState>;
  /** `to` empty = the whole team. */
  suggest: (itemId: string, to: string[], why: string) => Promise<{ sent: boolean; id: string }>;
  preview: (cardId: string, agents: string[]) => Promise<ShelfPreview>;
  /** `trusted` is the person's own "I trust this" tick; never true otherwise. */
  add: (cardId: string, agents: string[], trusted: boolean) => Promise<ShelfApplied>;
  undo: (token: string, itemId: string) => Promise<ShelfUndone>;
  dismiss: (cardId: string) => Promise<boolean>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const shelfApi: ShelfApi = {
  state: () => call('shelf_state'),
  suggest: (itemId, to, why) => call('shelf_suggest', { itemId, to, why }),
  preview: (cardId, agents) => call('shelf_preview', { cardId, agents }),
  add: (cardId, agents, trusted) => call('shelf_add', { cardId, agents, trusted }),
  undo: (token, itemId) => call('shelf_undo', { token, itemId }),
  dismiss: (cardId) => call('shelf_dismiss', { cardId }),
};
