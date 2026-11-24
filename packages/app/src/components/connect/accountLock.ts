import { rawText } from '../../lib/sayError';
// When the account route is paused (here or at the other PC), Open fails with a marker and the time it ends. The page says it in plain words.

/** What the PC prints in front of the time (unix ms) when the account route is paused (see `ACCOUNT_LOCKED_MARK` in the backend). */
const LOCKED_MARK = 'account_locked_until:';

/** The pause end as the person's own clock shows it: HH:MM today, with the day when it is not today. */
export function lockTime(ms: number, nowMs: number = Date.now()): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return at.toDateString() === new Date(nowMs).toDateString() ? time : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The pause end in an error from Open, kept between now and a day from now (no lock lasts longer; a wild number from another PC cannot
 * print a silly time). 0 means the pause is real but its time cannot be read; null means it is some other error.
 */
export function lockedUntilOf(e: unknown, nowMs: number = Date.now()): number | null {
  const text = rawText(e);
  if (!text.startsWith(LOCKED_MARK)) return null;
  const digits = text.slice(LOCKED_MARK.length);
  const n = /^\d{1,15}$/.test(digits) ? Number(digits) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, nowMs), nowMs + DAY_MS) : 0;
}
