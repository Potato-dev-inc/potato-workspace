// Notification levels: how loud each agent is, quiet hours and the 30-minute snooze. Pure, so the
// phone and the desktop can both use it. Every function takes the time as an argument.
//
// Rules (decided 2026-11-13, the founder was asleep):
// - A high-risk approval or a consent card always notifies. Level, quiet hours and snooze do not stop it.
// - A snoozed or silenced item still counts in the Inbox number. This module never changes a count.
import type { AttentionKind } from './attention';
import { isBlockingKind, type NeedsYouKind } from './attention';

export type BellLevel = 'everything' | 'needs' | 'finished' | 'silent';

export const BELL_LEVELS: readonly BellLevel[] = ['everything', 'needs', 'finished', 'silent'];

/** A plain agent is loud by default (today's behaviour). A helper starts quieter. */
export const DEFAULT_LEVEL = 'everything' satisfies BellLevel;
export const DEFAULT_HELPER_LEVEL = 'needs' satisfies BellLevel;

/** How long a snoozed card stays quiet. */
export const SNOOZE_MS = 30 * 60_000;

/** The level for an agent with no choice saved yet. */
export function defaultBellLevel(isHelper: boolean): BellLevel {
  return isHelper ? DEFAULT_HELPER_LEVEL : DEFAULT_LEVEL;
}

/** A stored value back to a level; anything else is null. */
export function parseBellLevel(value: unknown): BellLevel | null {
  return typeof value === 'string' && (BELL_LEVELS as readonly string[]).includes(value) ? (value as BellLevel) : null;
}

export interface QuietHours {
  enabled: boolean;
  /** Minutes after midnight, 0 to 1439. */
  start: number;
  end: number;
}

export const QUIET_OFF: QuietHours = { enabled: false, start: 22 * 60, end: 7 * 60 };

/** True when the local time is inside the quiet window. A window may cross midnight (22:00 to 07:00). */
export function inQuietHours(minuteOfDay: number, quiet: QuietHours): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const m = minuteOfDay;
  return quiet.start < quiet.end ? m >= quiet.start && m < quiet.end : m >= quiet.start || m < quiet.end;
}

/** The snooze end for a card snoozed at `now`. */
export const snoozeUntil = (now: number): number => now + SNOOZE_MS;

export const isSnoozed = (until: number | null | undefined, now: number): boolean => typeof until === 'number' && until > now;

export interface AlertEvent {
  kind: AttentionKind;
  risk?: 'low' | 'medium' | 'high' | null;
}

export type AlertReason = 'risky' | 'level' | 'quiet_hours' | 'snoozed' | 'shown';

export interface AlertDecision {
  /** True when the alert may be sent or shown. */
  notify: boolean;
  /** Why: `risky` is the one that overrides the others. */
  reason: AlertReason;
}

/** A card the person must decide on now (not a finished run, not an answer that waits in Ready). */
export function isNeedsMeEvent(kind: AttentionKind): boolean {
  return kind !== 'done' && isBlockingKind(kind as NeedsYouKind);
}

/** The level says whether this kind of event is loud enough for this agent. */
export function levelWants(level: BellLevel, kind: AttentionKind): boolean {
  switch (level) {
    case 'everything':
      return true;
    case 'needs':
      return isNeedsMeEvent(kind);
    case 'finished':
      return kind === 'done';
    default:
      return false;
  }
}

/** Is this event one that can never be silenced? A high-risk approval, or a consent card. */
export function isRiskyEvent(event: AlertEvent): boolean {
  return event.risk === 'high' || event.kind === 'consent';
}

/**
 * One decision for one alert. Order: risky always notifies; then the agent's level; then quiet hours;
 * then the snooze on this card.
 */
export function decideAlert(
  event: AlertEvent,
  opts: { level: BellLevel; quiet: QuietHours; minuteOfDay: number; snoozedUntil?: number | null; now: number },
): AlertDecision {
  if (isRiskyEvent(event)) return { notify: true, reason: 'risky' };
  if (!levelWants(opts.level, event.kind)) return { notify: false, reason: 'level' };
  if (inQuietHours(opts.minuteOfDay, opts.quiet)) return { notify: false, reason: 'quiet_hours' };
  if (isSnoozed(opts.snoozedUntil, opts.now)) return { notify: false, reason: 'snoozed' };
  return { notify: true, reason: 'shown' };
}
