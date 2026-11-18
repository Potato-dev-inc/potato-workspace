import { afterEach, describe, expect, it, vi } from 'vitest';
import { actUrl, askWhere, forgetWhere, mayBePointedAt, networkBase, repoint, resolveTunnel, tunnelFromAnswer, WhereError, type Fetcher } from './where';

const TUNNEL = 'https://rapid-able-wolf-3.trycloudflare.com';
const WORKER = 'https://pm.me.workers.dev';
const json = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
const place = (origin: string) => {
  const u = new URL(origin);
  return { origin: u.origin, protocol: u.protocol, hostname: u.hostname };
};

afterEach(() => forgetWhere());

describe('which pages may be pointed at a PC', () => {
  it('a Worker origin on workers.dev or an own domain may; a quick tunnel, loopback and plain http may not', () => {
    for (const o of [WORKER, 'https://phone.example.com']) expect(mayBePointedAt(place(o))).toBe(true);
    for (const o of [TUNNEL, 'http://127.0.0.1:17421', 'http://localhost:5173', 'https://localhost', 'http://pm.me.workers.dev']) expect(mayBePointedAt(place(o)), o).toBe(false);
  });
});

describe('the answer of /_pm/where', () => {
  it('only a quick-tunnel address is accepted (no open redirect to any other server)', () => {
    expect(tunnelFromAnswer({ ok: true, url: TUNNEL })).toBe(TUNNEL);
    for (const bad of [{ ok: true, url: 'https://evil.example.com' }, { ok: true, url: `${TUNNEL}/x` }, { ok: false, url: TUNNEL }, { ok: true }, 'x', null, { ok: true, url: 'http://a.trycloudflare.com' }]) expect(tunnelFromAnswer(bad)).toBeNull();
  });

  it('asks the Worker without cookies, and says null when the route does not exist or is not JSON (an older Worker, or the PC itself)', async () => {
    const seen: RequestInit[] = [];
    const fetcher: Fetcher = async (_u, init) => (seen.push(init ?? {}), json({ ok: true, url: TUNNEL }));
    expect(await askWhere(WORKER, fetcher)).toBe(TUNNEL);
    expect(seen[0].credentials).toBe('omit');
    expect(await askWhere(WORKER, async () => json({}, 404))).toBeNull();
    expect(await askWhere(WORKER, async () => json('<html/>', 200, 'text/html'))).toBeNull();
  });

  it('a Worker that is down, not linked or busy is an error the caller can wait out', async () => {
    await expect(askWhere(WORKER, async () => json({ ok: false }, 503))).rejects.toMatchObject({ status: 503 });
    await expect(askWhere(WORKER, async () => json({ ok: false }, 429))).rejects.toBeInstanceOf(WhereError);
    await expect(askWhere(WORKER, async () => Promise.reject(new TypeError('offline')))).rejects.toMatchObject({ status: null });
  });
});

describe('remembering and re-asking', () => {
  it('asks once, keeps the answer in memory, and a forced ask goes to the Worker again (a restart gave a new address)', async () => {
    const fetcher = vi.fn<Fetcher>();
    fetcher.mockResolvedValueOnce(json({ ok: true, url: TUNNEL })).mockResolvedValueOnce(json({ ok: true, url: 'https://new-one-9.trycloudflare.com' }));
    expect(await resolveTunnel(WORKER, { fetcher })).toBe(TUNNEL);
    expect(await resolveTunnel(WORKER, { fetcher })).toBe(TUNNEL);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await resolveTunnel(WORKER, { fetcher, fresh: true })).toBe('https://new-one-9.trycloudflare.com');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.cache).toBe('reload');
  });

  it('every origin is asked about itself: the earlier address and a new own domain keep separate answers', async () => {
    const fetcher: Fetcher = async (u) => json({ ok: true, url: u.startsWith(WORKER) ? TUNNEL : 'https://own-1.trycloudflare.com' });
    expect(await resolveTunnel(WORKER, { fetcher })).toBe(TUNNEL);
    expect(await resolveTunnel('https://phone.example.com', { fetcher })).toBe('https://own-1.trycloudflare.com');
  });

  it('networkBase points the saved bridge address at the tunnel, and keeps it when there is nothing to point at', async () => {
    const fetcher: Fetcher = async () => json({ ok: true, url: TUNNEL });
    expect(await networkBase(`${WORKER}/bridge`, place(WORKER), fetcher)).toBe(`${TUNNEL}/bridge`);
    forgetWhere();
    expect(await networkBase(`${WORKER}/bridge`, place(WORKER), async () => json({}, 404))).toBe(`${WORKER}/bridge`);
    forgetWhere();
    // The Worker cannot name the PC: never the Worker's own /bridge, a plain sentence instead
    await expect(networkBase(`${WORKER}/bridge`, place(WORKER), async () => json({}, 503))).rejects.toThrow(/Can't reach your PC right now/);
    await expect(networkBase(`${WORKER}/bridge`, place(WORKER), async () => Promise.reject(new TypeError('offline')))).rejects.toBeInstanceOf(WhereError);
    // not a Worker page: untouched, and never asked
    const never = vi.fn<Fetcher>();
    expect(await networkBase(`${TUNNEL}/bridge`, place(TUNNEL), never)).toBe(`${TUNNEL}/bridge`);
    expect(never).not.toHaveBeenCalled();
  });

  it('repoint swaps only the origin', () => {
    expect(repoint(`${WORKER}/bridge`, WORKER, TUNNEL)).toBe(`${TUNNEL}/bridge`);
    expect(repoint('https://other.example/bridge', WORKER, TUNNEL)).toBe('https://other.example/bridge');
  });
});

describe('the lock-screen Allow / Deny tap', () => {
  it('goes to the tunnel the Worker names; no route stays on the page origin; a Worker that cannot say sends nothing', async () => {
    expect(await actUrl('/bridge/push/act', `${WORKER}/`, async () => json({ ok: true, url: TUNNEL }))).toBe(`${TUNNEL}/bridge/push/act`);
    expect(await actUrl('/bridge/push/act', `${WORKER}/`, async () => json({}, 503))).toBeNull();
    expect(await actUrl('/bridge/push/act', `${WORKER}/`, async () => json({}, 404))).toBe(`${WORKER}/bridge/push/act`);
    expect(await actUrl('/bridge/push/act', `${TUNNEL}/`)).toBe(`${TUNNEL}/bridge/push/act`);
  });
});
