// @vitest-environment jsdom
// The phone page from a Worker: the first ask names the tunnel, a down link re-asks (slowly), a new tunnel replaces the old one.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPollState } from '../lib/runtime/pollWithBackoff';
import { forgetWhere, type Fetcher } from '../pwa/where';
import { REASK_MS, useDirectBridge, type DirectBridge } from './useDirectBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const WORKER = 'https://pm.me.workers.dev';
const A = 'https://aaa-1.trycloudflare.com';
const B = 'https://bbb-2.trycloudflare.com';
const place = { origin: WORKER, protocol: 'https:', hostname: 'pm.me.workers.dev' };
const answer = (url: string | null, status = 200) => new Response(JSON.stringify(url ? { ok: true, url } : { ok: false }), { status, headers: { 'content-type': 'application/json' } });

let root: Root;
let host: HTMLElement;
let latest: DirectBridge;
beforeEach(() => {
  vi.useFakeTimers();
  forgetWhere();
  resetPollState();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function Probe({ saved, fetcher, at }: { saved: string | null; fetcher: Fetcher; at: typeof place }) {
  latest = useDirectBridge(saved, at, fetcher);
  return null;
}
const mount = async (saved: string | null, fetcher: Fetcher, at = place) => {
  await act(async () => {
    root.render(createElement(Probe, { saved, fetcher, at }));
  });
};
const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useDirectBridge', () => {
  it('first ask: calls go to the tunnel the Worker names, with the saved path kept', async () => {
    const fetcher = vi.fn<Fetcher>(async () => answer(A));
    await mount(`${WORKER}/bridge`, fetcher);
    await flush();
    expect(latest.url).toBe(`${A}/bridge`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a page that is not a Worker page is left alone and nobody is asked', async () => {
    const fetcher = vi.fn<Fetcher>();
    await mount('http://127.0.0.1:17421/bridge', fetcher, { origin: 'http://127.0.0.1:17421', protocol: 'http:', hostname: '127.0.0.1' });
    expect(latest.url).toBe('http://127.0.0.1:17421/bridge');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a Worker that cannot name the PC yet: no address (never the Worker itself), then it is asked again and the poll ends when it answers', async () => {
    let up = false;
    const fetcher = vi.fn<Fetcher>(async () => (up ? answer(A) : answer(null, 503)));
    await mount(`${WORKER}/bridge`, fetcher);
    await flush();
    expect(latest.url).toBeNull();
    await flush(REASK_MS * 1.3);
    expect(latest.url).toBeNull();
    up = true;
    await flush(REASK_MS * 3);
    expect(latest.url).toBe(`${A}/bridge`);
    const asked = fetcher.mock.calls.length;
    await flush(REASK_MS * 6);
    expect(fetcher.mock.calls.length).toBe(asked);
    // the link line saying "connected" does not have to stop anything now, and a later stale poll still works
    act(() => latest.setStale(false));
  });

  it('while the link is down it re-asks with a wait, picks up the new tunnel after a restart, and stops when told', async () => {
    let next = A;
    const fetcher = vi.fn<Fetcher>(async () => answer(next));
    await mount(`${WORKER}/bridge`, fetcher);
    await flush();
    expect(latest.url).toBe(`${A}/bridge`);
    next = B; // the PC restarted and registered a new quick address
    act(() => latest.setStale(true));
    await flush(REASK_MS * 1.3);
    expect(latest.url).toBe(`${B}/bridge`);
    const asked = fetcher.mock.calls.length;
    act(() => latest.setStale(false));
    await flush(REASK_MS * 5);
    expect(fetcher.mock.calls.length).toBe(asked);
  });

  it('a failing Worker is asked less and less often, never in a tight loop', async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return calls === 1 ? answer(A) : answer(null, 503);
    };
    await mount(`${WORKER}/bridge`, fetcher);
    await flush();
    act(() => latest.setStale(true));
    await flush(10 * 60_000);
    // 10 minutes of a Worker that says 503: far fewer than one ask every 15 s (40)
    expect(calls).toBeLessThan(20);
    expect(calls).toBeGreaterThan(3);
  });
});

describe('the shared memory', () => {
  it('a re-ask during the reconnect poll updates it, so pairing never uses the old tunnel', async () => {
    const { lastKnown } = await import('../pwa/where');
    let next = A;
    const fetcher = vi.fn<Fetcher>(async () => answer(next));
    await mount(`${WORKER}/bridge`, fetcher);
    await flush();
    expect(lastKnown(WORKER)).toBe(A);
    next = B;
    act(() => latest.setStale(true));
    await flush(REASK_MS * 1.3);
    expect(lastKnown(WORKER)).toBe(B);
  });
});
