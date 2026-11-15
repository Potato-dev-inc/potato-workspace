// The companion speaks first, with a quiet budget (workflow proposal 17). Pure rules plus a tiny settings store.
// Nothing here draws or calls the backend: the hook (hooks/useCompanionSpeak.ts) feeds it facts and shows the result.
//
// Rules: OFF unless the person turned it on. At most `perHour` bubbles in any hour (default 3), a pause after each,
// nothing while the person types, nothing in quiet hours (lib/notify-levels), nothing while the companion is asleep.
// "Too much" turns that kind off for good. Later hides that one thing for a while.
import { useSyncExternalStore } from 'react';

export const SPEAK_KEY = 'pm.companion.speak';
export const DEFAULT_PER_HOUR = 3;
export const MAX_PER_HOUR = 12;
/** A pause after each bubble. */
export const COOL_DOWN_MS = 5 * 60_000;
/** The person typed this recently: stay silent. */
export const TYPING_QUIET_MS = 8_000;
/** An agent has waited at least this long before the companion mentions it. */
export const WAIT_SPEAK_MS = 10 * 60_000;
/** "Later" hides that one thing for this long. */
export const LATER_MS = 30 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface SpeakSettings {
  on: boolean;
  perHour: number;
  /** The one-time quiet offer was answered (yes or no thanks). */
  offered: boolean;
}

export const SPEAK_DEFAULTS: SpeakSettings = { on: false, perHour: DEFAULT_PER_HOUR, offered: false };

export const clampPerHour = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_PER_HOUR;
  return Math.min(MAX_PER_HOUR, Math.max(1, v));
};

export function parseSpeak(raw: unknown): SpeakSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpeakSettings>;
  return { on: r.on === true, perHour: clampPerHour(r.perHour), offered: r.offered === true };
}

/** "Too much": half the budget, at least 1. */
export const halveBudget = (perHour: number): number => Math.max(1, Math.floor(clampPerHour(perHour) / 2));

export type SpeakKind = 'waiting' | 'finished' | 'usage';

export interface SpeakEvent {
  /** Stable: the same thing never speaks twice. */
  key: string;
  kind: SpeakKind;
  paneId?: string;
  name: string;
  /** waiting: whole minutes waited. */
  minutes?: number;
  /** waiting: it is a yes-or-no (approval) rather than a question. */
  yesNo?: boolean;
  /** usage: percent used. */
  percent?: number;
  /** usage: the highest threshold crossed (see USAGE_THRESHOLDS). */
  threshold?: number;
}

/** What the rules remember between bubbles. Memory only. */
export interface SpeakMemory {
  shownAt: number[];
  seen: ReadonlySet<string>;
  /** key -> hidden until (ms). */
  later: Readonly<Record<string, number>>;
  /** key -> when it was first shown (ms); lets saved memory be pruned. */
  seenAt: Readonly<Record<string, number>>;
  /** Kinds the person turned off with "Too much": never again. */
  muted: ReadonlySet<SpeakKind>;
  /** kind -> quiet until (ms): "Later" on a usage bubble. */
  kindLater: Readonly<Partial<Record<SpeakKind, number>>>;
}

export const SPEAK_MEMORY_START: SpeakMemory = { shownAt: [], seen: new Set(), later: {}, seenAt: {}, muted: new Set(), kindLater: {} };

/** A usage bubble speaks once per threshold per reset window. */
export const USAGE_THRESHOLDS: readonly number[] = [80, 95];
/** "Later" on a usage bubble: quiet for this long (it also waits for the next threshold). */
export const USAGE_LATER_MS = 60 * 60_000;
/** Saved memory older than this is dropped. */
export const MEMORY_KEEP_MS = 8 * 24 * 60 * 60_000;

/** The highest threshold at or below `percent`, or null when none is crossed. */
export const usageThreshold = (percent: number): number | null => {
  const hit = USAGE_THRESHOLDS.filter((t) => percent >= t);
  return hit.length ? hit[hit.length - 1] : null;
};

export interface SpeakContext {
  now: number;
  /** When the person last typed in a field (ms), or null. */
  lastTypedAt: number | null;
  inQuietHours: boolean;
  asleep: boolean;
}

/** Why nothing is said right now, or null when something may be. Used by tests and the hook. */
export function silenceReason(
  settings: SpeakSettings,
  memory: SpeakMemory,
  ctx: SpeakContext,
): 'off' | 'asleep' | 'quiet_hours' | 'typing' | 'cool_down' | 'budget' | null {
  if (!settings.on) return 'off';
  if (ctx.asleep) return 'asleep';
  if (ctx.inQuietHours) return 'quiet_hours';
  if (ctx.lastTypedAt !== null && ctx.now - ctx.lastTypedAt < TYPING_QUIET_MS) return 'typing';
  const recent = memory.shownAt.filter((at) => ctx.now - at < HOUR_MS);
  if (recent.some((at) => ctx.now - at < COOL_DOWN_MS)) return 'cool_down';
  if (recent.length >= clampPerHour(settings.perHour)) return 'budget';
  return null;
}

const RANK: Record<SpeakKind, number> = { waiting: 0, usage: 1, finished: 2 };

/** The one thing worth saying now (the longest wait first), or null. */
export function pickSpeak(settings: SpeakSettings, memory: SpeakMemory, ctx: SpeakContext, candidates: readonly SpeakEvent[]): SpeakEvent | null {
  if (silenceReason(settings, memory, ctx) !== null) return null;
  const fresh = candidates.filter(
    (e) => !memory.seen.has(e.key) && (memory.later[e.key] ?? 0) <= ctx.now && !memory.muted.has(e.kind) && (memory.kindLater[e.kind] ?? 0) <= ctx.now,
  );
  if (fresh.length === 0) return null;
  return [...fresh].sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.minutes ?? 0) - (a.minutes ?? 0))[0];
}

/** The memory after a bubble was shown. */
export function afterShown(memory: SpeakMemory, event: SpeakEvent, now: number): SpeakMemory {
  return { ...memory, shownAt: [...memory.shownAt.filter((at) => now - at < HOUR_MS), now], seen: new Set([...memory.seen, event.key]), seenAt: { ...memory.seenAt, [event.key]: now } };
}

/** "Later": the same thing may come back after `LATER_MS`. */
export function afterLater(memory: SpeakMemory, event: SpeakEvent, now: number): SpeakMemory {
  // A usage bubble is not repeated: this threshold stays seen and the kind rests for an hour. It comes back at the next threshold.
  if (event.kind === 'usage') return { ...memory, kindLater: { ...memory.kindLater, usage: now + USAGE_LATER_MS } };
  const seen = new Set(memory.seen);
  seen.delete(event.key);
  return { ...memory, seen, later: { ...memory.later, [event.key]: now + LATER_MS } };
}

/** "Too much": this kind never speaks again (until turned back on). */
export const afterTooMuch = (memory: SpeakMemory, kind: SpeakKind): SpeakMemory => ({ ...memory, muted: new Set([...memory.muted, kind]) });

/** Turn a muted kind back on (Settings). */
export function unmuteKind(memory: SpeakMemory, kind: SpeakKind): SpeakMemory {
  const muted = new Set(memory.muted);
  muted.delete(kind);
  return { ...memory, muted };
}

/** Settings turned a kind back on: the running hook reads its memory again. */
export const MEMORY_CHANGED_EVENT = 'pm:companion-speak-memory';

/** The kinds the person turned off with "Too much", read from what was saved. */
export const mutedKinds = (): SpeakKind[] => KINDS.filter((k) => loadMemory(Date.now()).muted.has(k));

/** Turn one saved kind back on, now and for the hook that is running. */
export function unmuteSaved(kind: SpeakKind): void {
  saveMemory(unmuteKind(loadMemory(Date.now()), kind));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MEMORY_CHANGED_EVENT));
}

// ---- Memory that survives a reload ---------------------------------------------------------------------------

export const SPEAK_MEMORY_KEY = 'pm.companion.speak.memory';
const KINDS: readonly SpeakKind[] = ['waiting', 'finished', 'usage'];

export function parseMemory(raw: unknown, now: number): SpeakMemory {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rec = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object') for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    return out;
  };
  const seenAt = Object.fromEntries(Object.entries(rec(r.seenAt)).filter(([, at]) => now - at <= MEMORY_KEEP_MS));
  const later = Object.fromEntries(Object.entries(rec(r.later)).filter(([, until]) => now - until <= MEMORY_KEEP_MS));
  const kindLater: Partial<Record<SpeakKind, number>> = {};
  for (const [k, n] of Object.entries(rec(r.kindLater))) if ((KINDS as readonly string[]).includes(k)) kindLater[k as SpeakKind] = n;
  const muted = new Set((Array.isArray(r.muted) ? r.muted : []).filter((k): k is SpeakKind => (KINDS as readonly unknown[]).includes(k)));
  return { shownAt: [], seen: new Set(Object.keys(seenAt)), seenAt, later, muted, kindLater };
}

export function serializeMemory(memory: SpeakMemory): string {
  return JSON.stringify({ seenAt: memory.seenAt, later: memory.later, muted: [...memory.muted], kindLater: memory.kindLater });
}

export function loadMemory(now: number): SpeakMemory {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SPEAK_MEMORY_KEY);
    return parseMemory(raw ? JSON.parse(raw) : null, now);
  } catch {
    return SPEAK_MEMORY_START;
  }
}

export function saveMemory(memory: SpeakMemory): void {
  try {
    localStorage.setItem(SPEAK_MEMORY_KEY, serializeMemory(memory));
  } catch {
    // Storage is blocked: the memory lasts for this session.
  }
}

/** Whole minutes between `since` and `now` (never negative). */
export const minutesSince = (since: number, now: number): number => Math.max(0, Math.floor((now - since) / 60_000));

// ---- The saved choice (this computer only) ----------------------------------------------------------------

function readStored(): SpeakSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SPEAK_KEY);
    return parseSpeak(raw ? JSON.parse(raw) : null);
  } catch {
    return SPEAK_DEFAULTS;
  }
}

let current: SpeakSettings = readStored();
const listeners = new Set<() => void>();

export const getSpeak = (): SpeakSettings => current;

export function setSpeak(patch: Partial<SpeakSettings>): SpeakSettings {
  current = parseSpeak({ ...current, ...patch });
  try {
    localStorage.setItem(SPEAK_KEY, JSON.stringify(current));
  } catch {
    // Storage is blocked: the change still applies for this session.
  }
  listeners.forEach((l) => l());
  return current;
}

/** Tests only: read the saved value again. */
export function reloadSpeakForTests(): void {
  current = readStored();
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useSpeakSettings(): [SpeakSettings, (patch: Partial<SpeakSettings>) => void] {
  const s = useSyncExternalStore(subscribe, getSpeak, getSpeak);
  return [s, setSpeak];
}
