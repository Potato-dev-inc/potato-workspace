// One shared way to poll another PC through the relay. The relay (a free-tier Worker) bills every request, so a poller must
// never hammer a PC that is away: it backs off on failure, stops while the window is hidden or the network is down, asks at
// most once at a time per (device, route), and treats a relay 5xx as "that PC is offline" (looked at again once a minute).

/** The longest wait after failures. */
export const POLL_MAX_MS = 60_000;
/** How often an offline PC is looked at again. */
export const OFFLINE_RECHECK_MS = 60_000;

/** The delay after `failures` failures in a row: doubles from `normalMs`, never past `maxMs`. No jitter (see `jittered`). */
export function backoffDelay(failures: number, normalMs: number, maxMs = POLL_MAX_MS): number {
  if (failures <= 0) return normalMs;
  return Math.min(maxMs, normalMs * 2 ** Math.min(failures, 20));
}

/** +-20% so many pollers that failed together do not come back together. `random` is 0..1. */
export function jittered(ms: number, random: number = Math.random()): number {
  return Math.round(ms * (0.8 + 0.4 * random));
}

const statusOf = (error: unknown): number | null => {
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
};

/** The relay or the far PC is not answering: a network error, a timeout, 429 or any 5xx (530 / 1033 included). A 4xx refusal is an answer. */
export function isPollFailure(error: unknown): boolean {
  const s = statusOf(error);
  return s === null || s === 429 || s >= 500;
}

/** The relay says the tunnel is gone (any 5xx): that PC counts as offline until a recheck works. */
export function isOfflineSignal(error: unknown): boolean {
  const s = statusOf(error);
  return s !== null && s >= 500;
}

const offline = new Map<string, number>();
/** Marks a PC offline (kept until one call to it works). */
export function markDeviceOffline(node: string): void {
  offline.set(node, Date.now());
}
export function markDeviceOnline(node: string): void {
  offline.delete(node);
}
export function isDeviceMarkedOffline(node: string): boolean {
  return offline.has(node);
}
/** Forgets everything (tests). */
export function resetPollState(): void {
  offline.clear();
  inFlight.clear();
}

const inFlight = new Set<string>();

const hiddenNow = (): boolean => (typeof document !== 'undefined' && document.hidden === true) || (typeof navigator !== 'undefined' && navigator.onLine === false);

export interface PollOptions {
  /** The far PC this asks (for the shared offline mark); omit for a poll that is not about one PC. */
  node?: string;
  /** What is asked, so two pollers of the same (node, route) never run at once. */
  route: string;
  /** The normal wait between answers. */
  normalMs: number | (() => number);
  maxMs?: number;
  /** One ask. A rejection is a failure (see `isPollFailure`). Resolve `'stop'` to end the polling. */
  run: () => Promise<unknown>;
  /** Ask once right away (default true). */
  immediate?: boolean;
}

/** Starts polling; the returned function stops it. */
export function pollWithBackoff(opts: PollOptions): () => void {
  const normal = () => (typeof opts.normalMs === 'function' ? opts.normalMs() : opts.normalMs);
  const key = `${opts.node ?? ''}|${opts.route}`;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitingForWake = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (hiddenNow()) {
      waitingForWake = true;
      return;
    }
    timer = setTimeout(() => void tick(), jittered(ms));
  };

  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    if (hiddenNow()) {
      waitingForWake = true;
      return;
    }
    if (inFlight.has(key)) return schedule(normal());
    inFlight.add(key);
    let next = normal();
    try {
      const out = await opts.run();
      if (opts.node) markDeviceOnline(opts.node);
      failures = 0;
      if (out === 'stop') stopped = true;
    } catch (error) {
      if (isPollFailure(error)) {
        failures += 1;
        if (isOfflineSignal(error) && opts.node) {
          markDeviceOffline(opts.node);
          next = Math.max(OFFLINE_RECHECK_MS, backoffDelay(failures, normal(), opts.maxMs));
        } else next = backoffDelay(failures, normal(), opts.maxMs);
      } else failures = 0;
    } finally {
      inFlight.delete(key);
    }
    schedule(next);
  };

  const wake = () => {
    if (stopped || !waitingForWake || hiddenNow()) return;
    waitingForWake = false;
    void tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
  if (typeof window !== 'undefined') window.addEventListener('online', wake);

  if (opts.immediate === false) schedule(normal());
  else void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
    if (typeof window !== 'undefined') window.removeEventListener('online', wake);
  };
}
