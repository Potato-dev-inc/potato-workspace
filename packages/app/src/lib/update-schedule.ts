// When a downloaded update installs, and what the person sees after the restart. Pure helpers plus a tiny
// localStorage note ("What is new", shown once). Nothing here installs anything; the update hook decides, using these.
import type { QuietHours } from './notify-levels';

/** The choice for a ready update while agents are working. */
export type UpdateWhen = 'finish' | 'tonight';

/** Where "Tonight" lands when the person has no quiet hours: 02:00. */
export const FALLBACK_NIGHT_MINUTE = 2 * 60;

/** The next time (ms) the clock reads the quiet-hours start, or 02:00 when quiet hours are off. Always after `now`. */
export function tonightTarget(now: number, quiet: QuietHours | null): number {
  const minute = quiet?.enabled ? quiet.start : FALLBACK_NIGHT_MINUTE;
  const at = new Date(now);
  at.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** "02:00" style label for the target, in the person's own clock format. */
export function targetLabel(target: number, locale?: string): string {
  return new Date(target).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * True when the update may install now: nobody is working, and for "Tonight" the time has come.
 * It never stops an agent: a working agent always means "not yet".
 */
export function dueToInstall(when: UpdateWhen, now: number, target: number | null, busyCount: number): boolean {
  if (busyCount > 0) return false;
  return when === 'finish' || (target !== null && now >= target);
}

// ---- "What is new" after the restart ---------------------------------------------------------------------

export const WHATS_NEW_KEY = 'pm.update.whatsNew';

export interface WhatsNewNote {
  /** The version that was being installed. */
  version: string;
  /** The changelog text from latest.json, kept as it came. */
  notes: string | null;
  /** How many chats were open (they come back by themselves). */
  chats: number;
}

const normal = (v: string): string => v.trim().replace(/^v/i, '');

/** Remembers what to show after the restart. Storage that is blocked just means no card. */
export function rememberWhatsNew(note: WhatsNewNote): void {
  try {
    window.localStorage.setItem(WHATS_NEW_KEY, JSON.stringify(note));
  } catch {
    /* no storage: no card */
  }
}

export function forgetWhatsNew(): void {
  try {
    window.localStorage.removeItem(WHATS_NEW_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The remembered note when the running version is the one that was being installed; it is removed at once, so it
 * shows one time only. A note for another version stays (the install may still happen).
 */
export function takeWhatsNew(runningVersion: string | null): WhatsNewNote | null {
  if (!runningVersion) return null;
  try {
    const raw = window.localStorage.getItem(WHATS_NEW_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<WhatsNewNote> | null;
    if (!v || typeof v.version !== 'string') {
      forgetWhatsNew();
      return null;
    }
    if (normal(v.version) !== normal(runningVersion)) return null;
    forgetWhatsNew();
    return { version: v.version, notes: typeof v.notes === 'string' ? v.notes : null, chats: typeof v.chats === 'number' && v.chats > 0 ? Math.floor(v.chats) : 0 };
  } catch {
    return null;
  }
}

/** At most `max` short lines from the changelog text: bullets and headings stripped, empty lines dropped. */
export function whatsNewLines(notes: string | null | undefined, max = 3): string[] {
  if (!notes) return [];
  return notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+•]|#{1,6}|\d+[.)])\s*/, '').replace(/[`*_]/g, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 140 ? `${line.slice(0, 139)}…` : line))
    .slice(0, max);
}
