// How long the welcome takes to a first useful result: from the start of the welcome to the first demo
// run finishing. Local only: one small record in this window's storage and one console line. Nothing
// is sent anywhere. The target is a median under 3 minutes (docs/plans/growth-ux.md, section 3.1).

export const TIMING_KEY = 'pm.firstrun.timing';
export const TARGET_MS = 3 * 60 * 1000;

export interface Timing {
  startedAt: number;
  /** Set once, when the first demo run completes. */
  firstResultMs?: number;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

const defaultStore = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readTiming(store: Store | null = defaultStore()): Timing | null {
  try {
    const raw = store?.getItem(TIMING_KEY);
    const value = raw ? (JSON.parse(raw) as Partial<Timing>) : null;
    return value && typeof value.startedAt === 'number' ? { startedAt: value.startedAt, firstResultMs: typeof value.firstResultMs === 'number' ? value.firstResultMs : undefined } : null;
  } catch {
    return null;
  }
}

function write(timing: Timing, store: Store | null): void {
  try {
    store?.setItem(TIMING_KEY, JSON.stringify(timing));
  } catch {
    /* storage blocked: the log line below still says it */
  }
}

/**
 * The welcome opened. A fresh start (or an earlier run that already finished) starts the clock again;
 * a resumed one keeps its clock.
 */
export function beginTiming(now: number, resumed: boolean, store: Store | null = defaultStore()): Timing {
  const before = readTiming(store);
  if (resumed && before && before.firstResultMs === undefined) return before;
  const next: Timing = { startedAt: now };
  write(next, store);
  return next;
}

/** The first demo run completed. Only the first one counts. Returns the milliseconds, or null if one was already recorded. */
export function recordFirstResult(now: number, store: Store | null = defaultStore(), log: (line: string) => void = (l) => console.info(l)): number | null {
  const before = readTiming(store);
  if (!before || before.firstResultMs !== undefined) return null;
  const ms = Math.max(0, now - before.startedAt);
  write({ ...before, firstResultMs: ms }, store);
  log(`[first-run] first result after ${Math.round(ms / 1000)}s (${ms <= TARGET_MS ? 'within' : 'over'} the 3 minute target)`);
  return ms;
}
