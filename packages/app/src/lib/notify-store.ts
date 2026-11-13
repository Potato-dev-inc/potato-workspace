// The notification choices: one bell level per agent, and the quiet hours. The source of truth is the PC (the
// Rust side, `notify_levels`), because the phone, Telegram and Discord alerts are filtered there. This file is
// the thin window onto it: a small in-memory copy that the screens read at once, and commands that save.
// Outside the desktop app (a plain browser, a test) the copy is kept in localStorage instead, as before; the
// first time the desktop app runs, any such saved choices are moved to the PC once.
// Every storage call is wrapped in try/catch: blocked or full storage means the defaults apply.
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { defaultBellLevel, parseBellLevel, QUIET_OFF, SNOOZE_MS, type BellLevel, type QuietHours } from './notify-levels';

export const BELL_KEY = 'pm.notify.bells';
export const QUIET_KEY = 'pm.notify.quiet';

const onPc = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ---- The copy the screens read -------------------------------------------------------------------------

interface Copy {
  bells: Record<string, BellLevel>;
  quiet: QuietHours;
  /** Snooze key -> end time (ms). */
  snoozes: Record<string, number>;
}

let pc: Copy | null = null; // set once the PC answered
let version = 0;
const listeners = new Set<() => void>();
const changed = (): void => {
  version += 1;
  listeners.forEach((l) => l());
};

function readLocalBells(): Record<string, BellLevel> {
  try {
    const raw = JSON.parse(localStorage.getItem(BELL_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, BellLevel> = {};
    for (const [agent, value] of Object.entries(raw)) {
      const level = parseBellLevel(value);
      if (level) out[agent] = level;
    }
    return out;
  } catch {
    return {};
  }
}

function readLocalQuiet(): QuietHours {
  try {
    const v = JSON.parse(localStorage.getItem(QUIET_KEY) ?? 'null') as Partial<QuietHours> | null;
    if (!v || typeof v !== 'object') return QUIET_OFF;
    return { enabled: v.enabled === true, start: inDay(v.start, QUIET_OFF.start), end: inDay(v.end, QUIET_OFF.end) };
  } catch {
    return QUIET_OFF;
  }
}

const inDay = (n: unknown, fallback: number): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1440 ? n : fallback);

/** What the PC sent, made safe: unknown levels dropped, minutes inside the day. */
function fromPc(raw: unknown): Copy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { bells?: Record<string, unknown>; quiet?: Partial<QuietHours>; snoozes?: Record<string, unknown> };
  const bells: Record<string, BellLevel> = {};
  for (const [k, v] of Object.entries(r.bells ?? {})) {
    const level = parseBellLevel(v);
    if (level) bells[k] = level;
  }
  const snoozes: Record<string, number> = {};
  for (const [k, v] of Object.entries(r.snoozes ?? {})) if (typeof v === 'number') snoozes[k] = v;
  const q = r.quiet ?? {};
  return { bells, quiet: { enabled: q.enabled === true, start: inDay(q.start, QUIET_OFF.start), end: inDay(q.end, QUIET_OFF.end) }, snoozes };
}

export function readBells(): Record<string, BellLevel> {
  return pc ? pc.bells : readLocalBells();
}

export function readQuiet(): QuietHours {
  return pc ? pc.quiet : readLocalQuiet();
}

/** The level for one agent: its saved choice, else the default for a helper or a plain agent. */
export function levelFor(agent: string, isHelper: boolean, saved: Record<string, BellLevel> = readBells()): BellLevel {
  return saved[agent] ?? defaultBellLevel(isHelper);
}

function adopt(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  pc = fromPc(raw);
  changed();
}

let loading: Promise<void> | null = null;

/** Ask the PC for the choices (once), and move old browser-storage choices there the first time. Never throws. */
export function loadNotifyPrefs(): Promise<void> {
  if (!onPc()) return Promise.resolve();
  loading ??= (async () => {
    try {
      const prefs = (await invoke('notify_prefs_get')) as { imported?: boolean } | null;
      if (prefs && prefs.imported !== true) {
        const bells = readLocalBells();
        const quiet = readLocalQuiet();
        if (Object.keys(bells).length > 0 || quiet.enabled) {
          adopt(await invoke('notify_prefs_import', { bells, quiet }));
          try {
            localStorage.removeItem(BELL_KEY);
            localStorage.removeItem(QUIET_KEY);
          } catch {
            // Blocked storage: nothing to clean.
          }
          return;
        }
      }
      if (prefs) adopt(prefs);
    } catch {
      loading = null; // try again next time a screen asks
    }
  })();
  return loading;
}

/** Test hook: forget what the PC said. */
export function resetNotifyStoreForTest(): void {
  pc = null;
  loading = null;
  version = 0;
  listeners.clear();
}

function save(command: string, args: Record<string, unknown>): void {
  void invoke(command, args)
    .then(adopt)
    .catch(() => undefined);
}

export function writeBell(agent: string, level: BellLevel): void {
  if (!agent) return;
  if (onPc()) {
    pc = { bells: { ...readBells(), [agent]: level }, quiet: readQuiet(), snoozes: pc?.snoozes ?? {} };
    changed();
    save('notify_bell_set', { key: agent, level });
    return;
  }
  try {
    localStorage.setItem(BELL_KEY, JSON.stringify({ ...readLocalBells(), [agent]: level }));
  } catch {
    // Storage is blocked or full: the choice lasts this session only.
  }
  changed();
}

export function writeQuiet(quiet: QuietHours): void {
  if (onPc()) {
    pc = { bells: readBells(), quiet, snoozes: pc?.snoozes ?? {} };
    changed();
    save('notify_quiet_set', { quiet });
    return;
  }
  try {
    localStorage.setItem(QUIET_KEY, JSON.stringify(quiet));
  } catch {
    // Not remembered; the default (off) applies next time.
  }
  changed();
}

/** Snooze alerts for these keys (the card's pane id, its question key) for 30 minutes. Counts in the Inbox are untouched. */
export function snooze(keys: string[], now: number = Date.now()): void {
  const until = now + SNOOZE_MS;
  const mine = { ...(pc?.snoozes ?? {}) };
  for (const k of keys) mine[k] = until;
  if (onPc()) {
    pc = { bells: readBells(), quiet: readQuiet(), snoozes: mine };
    changed();
    save('notify_snooze', { keys });
  }
}

export function isSnoozedKey(keys: string[], now: number = Date.now()): boolean {
  return keys.some((k) => (pc?.snoozes[k] ?? 0) > now);
}

// ---- React ---------------------------------------------------------------------------------------------

function useCopyVersion(): number {
  useEffect(() => {
    void loadNotifyPrefs();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => version,
    () => 0,
  );
}

/** The bell level of one agent, with a setter that remembers it. Re-reads when the agent or the PC's answer changes. */
export function useBellLevel(agent: string, isHelper: boolean): [BellLevel, (level: BellLevel) => void] {
  useCopyVersion();
  const level = levelFor(agent, isHelper);
  const set = useCallback((next: BellLevel) => writeBell(agent, next), [agent]);
  return [level, set];
}

/** The quiet hours, with a setter that remembers them. */
export function useQuietHours(): [QuietHours, (next: QuietHours) => void] {
  useCopyVersion();
  return [readQuiet(), writeQuiet];
}

/** Is a card snoozed right now, and a way to snooze it. */
export function useSnooze(keys: string[]): [boolean, () => void] {
  useCopyVersion();
  const id = keys.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doSnooze = useCallback(() => snooze(keys), [id]);
  return [isSnoozedKey(keys), doSnooze];
}
