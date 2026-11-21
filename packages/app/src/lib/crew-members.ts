// Which chat is which box of a crew. "Start crew" says it (role + pane id); this remembers it on this computer so the
// Inbox can offer "Show in crew". A chat that was not started from a crew is simply not here, and gets no button.
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

const KEY = 'pm.crew.members';
const MAX = 200;

export interface CrewMember {
  slug: string;
  role: string;
  /** This chat is the Front of a workflow (Labs "Workflows"): its chat can open the live view. */
  front?: boolean;
  /** The workflow's name, kept with the front mark so the sidebar can say it without loading the crew. */
  name?: string;
}

function rawMarks(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

// Parsed once per change of the stored text (a sidebar row and every render ask), and announced to whoever listens.
let seen: { raw: string | null; parsed: Record<string, CrewMember> } | null = null;
const listeners = new Set<() => void>();

function read(): Record<string, CrewMember> {
  const raw = rawMarks();
  if (seen && seen.raw === raw) return seen.parsed;
  let parsed: Record<string, CrewMember> = {};
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    if (v && typeof v === 'object') parsed = v as Record<string, CrewMember>;
  } catch {
    parsed = {};
  }
  seen = { raw, parsed };
  return parsed;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  window.addEventListener('storage', l);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', l);
  };
};

/** Re-renders the caller whenever a chat is marked (or the marks change in another window). Returns an opaque version. */
export function useCrewMarks(): string | null {
  const raw = useSyncExternalStore(subscribe, rawMarks);
  // The marks are this PC's to say: its PC-link rows carry them (`crew_marks_sync`), so another PC draws the same workflow row.
  useEffect(mirrorCrewMarks, [raw]);
  return raw;
}

/** Tells the app which chats are workflow fronts and crew boxes (it keeps them in memory; the window is where they are made and saved). */
export function mirrorCrewMarks(): void {
  try {
    invoke('crew_marks_sync', { marks: read() }).catch(() => undefined);
  } catch {
    /* no app behind the page (a browser or a test): nothing to tell */
  }
}

/** A crew just started: remember each role's chat. The newest MAX are kept. */
export function rememberCrewStart(slug: string, started: ReadonlyArray<{ role: string; pane_id: string }>, frontRole?: string | null, name?: string | null): void {
  if (started.length === 0) return;
  const all = read();
  for (const s of started) all[s.pane_id] = frontRole && s.role === frontRole ? { slug, role: s.role, front: true, ...(name ? { name } : {}) } : { slug, role: s.role };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage can be blocked: the button just does not show */
  }
  for (const l of [...listeners]) l();
}

/** The crew box this chat was started as, or null. */
export function crewOf(paneId: string | null | undefined): CrewMember | null {
  if (!paneId) return null;
  const m = read()[paneId];
  return m && typeof m.slug === 'string' && typeof m.role === 'string' ? m : null;
}
