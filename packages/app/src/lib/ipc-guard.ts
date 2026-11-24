// Every call to the desktop goes through `window.__TAURI_INTERNALS__.invoke` (that is what `invoke` from `@tauri-apps/api/core`
// calls), so wrapping that one function sees them all. It counts the calls in flight, shares identical read-only calls that
// are in flight together, and holds reads in a queue so that at most MAX_INFLIGHT of them are on their way to the desktop at once
// (Tauri registers a JS callback per call, so a burst of 1,800 calls once cost ~900 MB across the WebView2 processes). Writes never wait.

/** Reads that change nothing: two of them with the same arguments, in flight together, are answered by one call. */
export const SHARED_READS: ReadonlySet<string> = new Set([
  'pane_git_branch',
  'pane_worktree',
  'files_list',
  'files_marks',
  'mission_list',
  'lend_state',
  'checkpoint_turn_review',
  'plugin:store|get',
  'canary_status',
  'list_paired_mobile_devices',
  'budget_for_pane',
  'keep_going_lineage',
  'get_pane_remote',
]);
/** Reads whose answer is cheap to keep for a moment (a branch name does not change in a second). Any write drops them all. */
export const BRIEF_CACHE_MS: Readonly<Record<string, number>> = {
  pane_git_branch: 1000,
  pane_worktree: 1000,
  'plugin:store|get': 1000,
  canary_status: 5000,
  list_paired_mobile_devices: 5000,
  budget_for_pane: 3000,
  keep_going_lineage: 3000,
  get_pane_remote: 3000,
};
/** The per-chat reads that fire when a chat opens: one still waiting in the queue when its chat is left is dropped, never sent. */
export const PANE_OPEN_READS: ReadonlySet<string> = new Set([
  'branch_lineage',
  'artifacts_sync',
  'budget_for_pane',
  'keep_going_lineage',
  'pane_messages_list',
  'get_pane_remote',
  'acp_chat_state',
]);
/** Most reads on their way to the desktop at once. Each one in flight costs a callback in the page and memory in 4 processes. */
export const MAX_INFLIGHT = 16;
/** Past this many queued reads, the ones for a chat that was left are swept out at once. */
const SWEEP_AT = 200;
const QUEUE_WARN_MS = 20_000;
/** A read that is joined only while it is young: an event that came after it started may have changed the answer. */
const JOIN_AGE_MS = 300;
const WARN_AT = 500;
const WARN_AFTER_MS = 5000;
/** Commands that change something or do what the person just asked: never held behind reads. */
const WRITE =
  /(^|_)(send|write|start|stop|kill|close|answer|cancel|set|save|delete|remove|create|add|approve|deny|reject|resume|restart|connect|pair|lend|revoke|return|merge|discard|keep|put_back|undo|restore|install|update|rename|move|apply|reset|patch|clear|toggle|dismiss|edit|accept|submit|hold|open|spawn|run)(_|$)/;
/** A write that happens all the time and cannot change what a kept read says. */
const QUIET_WRITE = /^(write_pane_input|resize_pane|plugin:event\|emit)$/;

/** Names that read even when a word in them looks like a verb (`lend_state`, `keep_going_lineage`). */
const READ_NAME = /(_list|_state|_status|_lineage|_get|_for_pane)$/;

export const isWrite = (cmd: string): boolean =>
  cmd.startsWith('plugin:')
    ? cmd !== 'plugin:store|get' && cmd !== 'plugin:event|listen' && cmd !== 'plugin:event|unlisten'
    : !SHARED_READS.has(cmd) && !READ_NAME.test(cmd) && WRITE.test(cmd);

type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
interface Running {
  at: number;
  promise: Promise<unknown>;
}
interface Job {
  key: string;
  at: number;
  start: () => void;
  cancelled: () => boolean;
  abort: () => void;
  promise: Promise<unknown>;
}

const byCommand = new Map<string, number>();
let pending = 0;
const running = new Map<string, Running>();
let readsInFlight = 0;
const queue: Job[] = [];
const queued = new Map<string, Job>();
const recent = new Map<string, { at: number; value: unknown }>();
let overSince = 0;
let warned = false;
let queueWarned = false;
let watch: ReturnType<typeof setInterval> | null = null;
let activePane: string | null = null;
let generation = 0;

export const pendingInvokes = (): number => pending;
export const queuedInvokes = (): number => queue.length;

/** The commands most in flight right now, biggest first. */
export function pendingByCommand(top = 5): Array<[string, number]> {
  return [...byCommand.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

/** The chat on screen. Reads queued for the one that was on screen before are dropped, not sent. */
export function setActivePane(id: string | null): void {
  if (id === activePane) return;
  activePane = id;
  generation++;
  sweep();
}

/** Leaving a chat: only clears if it is still the one on screen (the next chat may already have taken over). */
export function leavePane(id: string): void {
  if (activePane === id) setActivePane(null);
}

export const abortError = (): Error => Object.assign(new Error('The call was cancelled before it was sent.'), { name: 'AbortError' });
export const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

function sweep(): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = queue[i]!;
    if (!job.cancelled()) continue;
    queue.splice(i, 1);
    if (queued.get(job.key) === job) queued.delete(job.key);
    job.abort();
  }
}

function pump(): void {
  while (readsInFlight < MAX_INFLIGHT && queue.length) {
    const job = queue.shift()!;
    if (queued.get(job.key) === job) queued.delete(job.key);
    job.start();
  }
}

/** The command and chat a call is about; a far PC's call travels as one `devices_request` and names both in its path and body. */
function aboutCall(cmd: string, args: unknown): { cmd: string; pane: string | null; far: boolean } {
  const a = (args ?? {}) as { path?: unknown; body?: unknown; paneId?: unknown };
  if (cmd === 'devices_request' && typeof a.path === 'string') {
    const m = /^\/pclink\/call\/([^/?]+)/.exec(a.path);
    if (m) {
      const body = (a.body ?? {}) as { paneId?: unknown; pane_id?: unknown };
      const id = body.paneId ?? body.pane_id;
      return { cmd: m[1]!, pane: typeof id === 'string' ? id : null, far: true };
    }
  }
  return { cmd, pane: typeof a.paneId === 'string' ? a.paneId : null, far: false };
}

const onScreen = (pane: string, far: boolean): boolean => activePane !== null && (far ? activePane.endsWith(`:${pane}`) : activePane === pane);

function check(): void {
  if (queue.length && !queueWarned && Date.now() - queue[0]!.at > QUEUE_WARN_MS) {
    queueWarned = true;
    console.warn(`${queue.length} reads have waited over 20 seconds for the desktop.`);
  }
  if (!queue.length) queueWarned = false;
  if (pending <= WARN_AT) {
    overSince = 0;
    warned = false;
    if (pending === 0 && !queue.length && watch) {
      clearInterval(watch);
      watch = null;
    }
    return;
  }
  overSince ||= Date.now();
  if (!warned && Date.now() - overSince > WARN_AFTER_MS) {
    warned = true;
    console.warn(`${pending} calls to the desktop are waiting. Most: ${pendingByCommand().map(([c, n]) => `${c} x${n}`).join(', ')}`);
  }
}

function track<T>(cmd: string, run: () => Promise<T>): Promise<T> {
  pending++;
  byCommand.set(cmd, (byCommand.get(cmd) ?? 0) + 1);
  if (!watch && typeof setInterval === 'function') watch = setInterval(check, 1000);
  const done = () => {
    pending--;
    const n = (byCommand.get(cmd) ?? 1) - 1;
    if (n > 0) byCommand.set(cmd, n);
    else byCommand.delete(cmd);
  };
  const p = run();
  void p.then(done, done);
  return p;
}

/** The wrapped function: `inner` is the original `invoke`. Exported so a test can drive it without a window. */
export function guardInvoke(inner: Invoke): Invoke {
  /** A read goes now while fewer than MAX_INFLIGHT run, otherwise it waits its turn (in order). `signal`, or leaving the chat it was made for, cancels it while it waits. */
  const schedule = (cmd: string, key: string, args: unknown, options: unknown, signal: AbortSignal | undefined, forPane: boolean): Promise<unknown> => {
    const gen = generation;
    let job!: Job;
    const promise = new Promise<unknown>((resolve, reject) => {
      job = {
        key,
        at: Date.now(),
        cancelled: () => !!signal?.aborted || (forPane && gen !== generation),
        abort: () => reject(abortError()),
        start: () => {
          if (job.cancelled()) return reject(abortError());
          readsInFlight++;
          const free = () => {
            readsInFlight--;
            pump();
          };
          const p = track(cmd, () => inner(cmd, args, options));
          void p.then(free, free);
          p.then(resolve, reject);
        },
        promise: null as never,
      };
    });
    job.promise = promise;
    if (readsInFlight < MAX_INFLIGHT && queue.length === 0) {
      job.start();
    } else {
      queue.push(job);
      queued.set(key, job);
      if (!watch && typeof setInterval === 'function') watch = setInterval(check, 1000);
      if (queue.length > SWEEP_AT) sweep();
    }
    return promise;
  };
  return (cmd, args, options) => {
    const about = aboutCall(cmd, args);
    if (isWrite(about.cmd)) {
      // Any write makes every kept read answer suspect (a store write, a settings patch, a remote-control change).
      if (!QUIET_WRITE.test(cmd)) recent.clear();
      return track(cmd, () => inner(cmd, args, options));
    }
    // `options.signal` is ours (Tauri's own options carry only headers): strip it before the real call.
    const { signal, ...rest } = (options ?? {}) as { signal?: AbortSignal };
    const opts = options === undefined ? undefined : rest;
    const forPane = PANE_OPEN_READS.has(about.cmd) && !!about.pane && onScreen(about.pane, about.far);
    const key = `${cmd}|${JSON.stringify(args ?? null)}|${forPane ? generation : ''}`;
    const now = Date.now();
    if (!SHARED_READS.has(cmd)) {
      // A read still waiting in the queue is the same read: one call answers both.
      const waiting = signal ? undefined : queued.get(key);
      return waiting ? waiting.promise : schedule(cmd, key, args, opts, signal, forPane);
    }
    const ttl = BRIEF_CACHE_MS[cmd];
    const hit = ttl ? recent.get(key) : undefined;
    if (hit && now - hit.at < ttl!) return Promise.resolve(hit.value);
    const live = signal ? undefined : running.get(key);
    if (live && (now - live.at < JOIN_AGE_MS || queue.length > 0)) return live.promise;
    const promise = schedule(cmd, key, args, opts, signal, forPane);
    const mine = { at: now, promise };
    running.set(key, mine);
    const end = () => {
      if (running.get(key) === mine) running.delete(key);
    };
    promise.then((value) => {
      end();
      if (ttl) {
        recent.set(key, { at: Date.now(), value });
        if (recent.size > 200) recent.delete(recent.keys().next().value as string);
      }
    }, end);
    return promise;
  };
}

/** Tests only. */
export function resetIpcGuard(): void {
  pending = 0;
  byCommand.clear();
  running.clear();
  recent.clear();
  readsInFlight = 0;
  queue.length = 0;
  queued.clear();
  activePane = null;
  generation = 0;
  queueWarned = false;
  overSince = 0;
  warned = false;
  if (watch) clearInterval(watch);
  watch = null;
}
