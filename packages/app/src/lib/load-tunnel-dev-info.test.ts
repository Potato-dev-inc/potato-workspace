// @vitest-environment jsdom
// The phone address is watched for as long as the page is open: it changes when the tunnel restarts or the person picks
// another way to connect, and a QR code made from the first address read would open a dead page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ url: 'https://one.trycloudflare.com' as string | null }));
vi.mock('./tauri', () => ({
  tauri: {
    getMobileTunnelInfo: vi.fn(async () => (mocks.url ? { tunnelUrl: mocks.url, bridgeProxyUrl: `${mocks.url}/bridge`, localUrl: 'http://127.0.0.1:1420' } : { tunnelUrl: null, bridgeProxyUrl: '', localUrl: 'http://127.0.0.1:1420' })),
  },
}));

import { watchTunnelDevInfo } from './load-tunnel-dev-info';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  mocks.url = 'https://one.trycloudflare.com';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('watchTunnelDevInfo', () => {
  it('keeps checking after it found an address, so a changed address reaches the page', async () => {
    const seen: Array<string | null | undefined> = [];
    const stop = watchTunnelDevInfo((info) => seen.push(info?.tunnelUrl));
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual(['https://one.trycloudflare.com']);
    mocks.url = 'https://pm-relay.me.workers.dev';
    await vi.advanceTimersByTimeAsync(4100);
    expect(seen.at(-1)).toBe('https://pm-relay.me.workers.dev');
    // Long after the first minute it still looks.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    mocks.url = 'https://three.trycloudflare.com';
    await vi.advanceTimersByTimeAsync(4100);
    expect(seen.at(-1)).toBe('https://three.trycloudflare.com');
    stop();
  });

  it('stops for good when the page stops watching', async () => {
    const onUpdate = vi.fn();
    const stop = watchTunnelDevInfo(onUpdate);
    await vi.advanceTimersByTimeAsync(10);
    stop();
    const calls = onUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onUpdate.mock.calls.length).toBe(calls);
  });

  it('gives up after a minute when no address ever shows up', async () => {
    mocks.url = null;
    const onUpdate = vi.fn();
    watchTunnelDevInfo(onUpdate);
    await vi.advanceTimersByTimeAsync(61_000);
    const calls = onUpdate.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onUpdate.mock.calls.length).toBe(calls);
  });
});
