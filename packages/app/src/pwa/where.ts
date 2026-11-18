// Where is the PC right now? The permanent address (the person's own Worker, on workers.dev or a domain of their own) only
// POINTS at the PC's quick tunnel: `GET /_pm/where` answers `{ ok: true, url }`. The phone page then sends every API call,
// stream and socket straight to that tunnel with its bearer token. The Worker carries none of them (that cost a Worker
// request and a subrequest per call and blew the free daily quota).
//
// No DOM and no window here: the service worker uses it too (the lock-screen Allow / Deny tap). Pure functions plus a small
// cache of the last answer, kept in memory only.

/** The only addresses a Worker may point a phone at: a quick tunnel. Anything else is refused (no open redirect to a stranger's server). */
export const QUICK_TUNNEL_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** What the person reads while the Worker cannot say where the PC is. */
export const CANT_REACH = "Can't reach your PC right now. Trying again…";

/** A failed ask. `status` is the HTTP status, or null when the network failed (`pollWithBackoff` reads it). */
export class WhereError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

interface Place {
  protocol: string;
  hostname: string;
  origin: string;
}

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * Whether this page may have been loaded from a Worker that points at the PC: an https page that is not itself a quick tunnel
 * and not loopback. (A named or own-domain tunnel serves the page from the PC and has no `/_pm/where`: the ask finds that out once.)
 */
export function mayBePointedAt(place: Pick<Place, 'protocol' | 'hostname'>): boolean {
  if (place.protocol !== 'https:') return false;
  const host = place.hostname.toLowerCase();
  return !isLoopback(host) && !host.endsWith('.trycloudflare.com');
}

/** The tunnel origin out of a `/_pm/where` answer, or null when the answer is not one (HTML, 404, junk, a foreign address). */
export function tunnelFromAnswer(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { ok, url } = body as { ok?: unknown; url?: unknown };
  return ok === true && typeof url === 'string' && QUICK_TUNNEL_RE.test(url) ? url : null;
}

/**
 * Ask the Worker at `origin` where the PC is. Returns the tunnel origin; `null` when this origin has no such route (the page
 * comes from the PC itself, or an older Worker still carries the calls: use the same origin as before). Throws `WhereError`
 * when the Worker says "not linked / busy" (5xx, 429) or the network fails, so the caller can wait and ask again.
 */
export async function askWhere(origin: string, fetcher: Fetcher = (u, i) => fetch(u, i), fresh = false, timeoutMs = 8000): Promise<string | null> {
  let res: Response;
  try {
    res = await fetcher(`${origin}/_pm/where`, {
      method: 'GET',
      // After a failure the cached answer (15 s) may be the old tunnel: go to the Worker.
      cache: fresh ? 'reload' : 'default',
      credentials: 'omit',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch {
    throw new WhereError(null, CANT_REACH);
  }
  if (res.status === 429 || res.status >= 500) throw new WhereError(res.status, CANT_REACH);
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  return tunnelFromAnswer(body);
}

/** `https://x.trycloudflare.com` -> `https://x.trycloudflare.com/bridge`. */
export const bridgeOf = (tunnel: string): string => `${tunnel}/bridge`;

/** Replace the page's own origin with the tunnel in a path-ish bridge URL (`<origin>/bridge` or any `<origin>/...`). */
export function repoint(url: string, from: string, tunnel: string): string {
  return url.startsWith(from) ? `${tunnel}${url.slice(from.length)}` : url;
}

// What the last ask said, per Worker origin, in memory only. `false` = "this origin has no where route".
const memo = new Map<string, string | false>();

/** The last known answer for `origin` without asking. */
export function lastKnown(origin: string): string | false | undefined {
  return memo.get(origin);
}

/** Ask (or reuse the last answer unless `fresh`) and remember it. Throws like `askWhere`. */
export async function resolveTunnel(origin: string, opts: { fresh?: boolean; fetcher?: Fetcher } = {}): Promise<string | null> {
  if (!opts.fresh) {
    const known = memo.get(origin);
    if (known !== undefined) return known === false ? null : known;
  }
  const tunnel = await askWhere(origin, opts.fetcher, opts.fresh === true);
  memo.set(origin, tunnel ?? false);
  return tunnel;
}

/** Forget what was learned (tests, or after a pairing is cleared). */
export function forgetWhere(): void {
  memo.clear();
}

/**
 * The address to send a bridge call to, for a saved bridge URL (`<page origin>/bridge`): the tunnel when the page comes from a
 * Worker that points at the PC, else the saved URL as it is (the page is the PC's own, or the Worker has no `where` route).
 * When the Worker should name the PC and cannot, this THROWS `WhereError` (`CANT_REACH`): the bridge is never called on the
 * Worker, which no longer carries it.
 */
export async function networkBase(saved: string, place: Place, fetcher?: Fetcher): Promise<string> {
  if (!mayBePointedAt(place) || !saved.startsWith(place.origin)) return saved;
  const tunnel = await resolveTunnel(place.origin, { fetcher });
  return tunnel ? repoint(saved, place.origin, tunnel) : saved;
}

/**
 * For the service worker: the address of a lock-screen Allow / Deny call. A relative `/bridge/...` path goes to the tunnel
 * when the Worker names one; with no Worker route it stays on the page's own origin. When the Worker should name the PC and
 * cannot, `null`: the tap is not sent (the Worker no longer carries `/bridge`).
 */
export async function actUrl(path: string, scope: string, fetcher?: Fetcher): Promise<string | null> {
  const here = new URL(scope);
  const own = new URL(path, here).href;
  if (!path.startsWith('/') || !mayBePointedAt(here)) return own;
  try {
    const tunnel = await askWhere(here.origin, fetcher, true);
    return tunnel ? `${tunnel}${path}` : own;
  } catch {
    return null;
  }
}
