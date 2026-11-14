// The draft of a new lend profile, kept OUTSIDE React so that closing the sheet, opening a chat or a crash does not lose it.
// It is mirrored to sessionStorage, but never the API key: that stays in memory only and is gone when the window is.
import { useSyncExternalStore } from 'react';
import { DEFAULT_SECS, type LendProfile } from './lend';

export type LendHow = 'signin' | 'existing' | 'key';
export type LendStep = 1 | 2 | 3 | 4;
export const STEPS = 4;
export const STORAGE_KEY = 'pm.lend.draft.v1';

export interface LendDraft {
  /** The profile being made (or edited). `id` is empty until it is saved once. */
  profile: LendProfile;
  step: LendStep;
  how: LendHow;
  /** The lend sign-in this draft uses ('' for none yet). */
  accountId: string;
  /** The lend sign-in THIS draft made ('' when it used one that was already there), so Discard may offer to remove it. */
  createdId: string;
  understood: boolean;
  /** A key was already saved for the profile being edited. */
  hadKey: boolean;
  removeKey: boolean;
  /** An existing profile is being edited: closing the sheet does not leave a "Finish setting up" row. */
  editing: boolean;
  /** The API key typed so far. In memory only: never written to sessionStorage. */
  key: string;
}

export const blankProfile = (): LendProfile => ({
  id: '',
  name: '',
  agent_ids: [],
  account: { kind: 'account', id: '' },
  who: 'my_pcs',
  member_ids: [],
  default_secs: DEFAULT_SECS,
  max_secs: 24 * 3600,
  approval: 'each',
  sign_out_on_end: true,
  keep_awake: true,
  max_requests: null,
  max_tokens: null,
});

export const blankDraft = (): LendDraft => ({
  profile: blankProfile(),
  step: 1,
  how: 'signin',
  accountId: '',
  createdId: '',
  understood: false,
  hadKey: false,
  removeKey: false,
  editing: false,
  key: '',
});

/** A draft for a profile that is already saved: opens on the review step. */
export function draftFor(p: LendProfile): LendDraft {
  const accountId = p.account.kind === 'account' ? p.account.id : '';
  return {
    ...blankDraft(),
    profile: { ...p },
    step: 4,
    how: p.has_key ? 'key' : accountId ? 'existing' : 'signin',
    accountId,
    hadKey: p.has_key === true,
    editing: true,
    understood: p.who === 'teammates',
  };
}

let current: LendDraft | null = null;
let loaded = false;
const listeners = new Set<() => void>();

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

/** What is written down: the draft without the key. */
const persisted = (d: LendDraft): Omit<LendDraft, 'key'> => {
  const { key: _key, ...rest } = d;
  void _key;
  return rest;
};

/** A stored value that is not a draft of this shape is dropped (a broken or old entry never breaks the page). */
export function parseDraft(text: string | null): LendDraft | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<LendDraft> | null;
    const p = v?.profile;
    if (!v || typeof v !== 'object' || !p || typeof p !== 'object' || typeof p.name !== 'string' || !Array.isArray(p.agent_ids)) return null;
    if (![1, 2, 3, 4].includes(Number(v.step)) || !['signin', 'existing', 'key'].includes(String(v.how)) || typeof v.accountId !== 'string') return null;
    return { ...blankDraft(), ...v, profile: { ...blankProfile(), ...p }, key: '' } as LendDraft;
  } catch {
    return null;
  }
}

function load() {
  if (loaded) return;
  loaded = true;
  const s = storage();
  try {
    const d = parseDraft(s?.getItem(STORAGE_KEY) ?? null);
    if (d) current = d;
    else if (s?.getItem(STORAGE_KEY)) s.removeItem(STORAGE_KEY);
  } catch {
    /* no storage: the draft lives in memory */
  }
}

function write() {
  const s = storage();
  try {
    if (!s) return;
    if (current && !current.editing) s.setItem(STORAGE_KEY, JSON.stringify(persisted(current)));
    else s.removeItem(STORAGE_KEY);
  } catch {
    /* private window or blocked storage: memory only */
  }
}

export const getDraft = (): LendDraft | null => {
  load();
  return current;
};

/** Replaces the draft (a new one, or the whole updated one). */
export function setDraft(next: LendDraft): void {
  load();
  current = next;
  write();
  for (const l of [...listeners]) l();
}

/** Merges into the draft (it must exist). */
export function patchDraft(patch: Partial<LendDraft>): void {
  if (!current) return;
  setDraft({ ...current, ...patch });
}

export function patchProfile(patch: Partial<LendProfile>): void {
  if (!current) return;
  setDraft({ ...current, profile: { ...current.profile, ...patch } });
}

export function clearDraft(): void {
  load();
  current = null;
  write();
  for (const l of [...listeners]) l();
}

export function subscribeDraft(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tests: forget everything, including what was loaded from storage. */
export function resetDraftForTests(): void {
  current = null;
  loaded = false;
  listeners.clear();
}

export const useLendDraft = (): LendDraft | null => useSyncExternalStore(subscribeDraft, getDraft, getDraft);

/** Whether the draft holds anything worth finishing later (a name, an agent or a sign-in). */
export const draftHasWork = (d: LendDraft | null): boolean => !!d && (d.profile.name.trim() !== '' || d.profile.agent_ids.length > 0 || d.accountId !== '' || d.key !== '');
