import { describe, expect, it } from 'vitest';
import { resolvePhoneAddress } from './phone-address';
import type { TunnelStatus } from './tauri-types';

const WORKER = 'https://pm.me.workers.dev';
const QUICK = 'https://rapid-able-wolf-3.trycloudflare.com';
const status = (over: Partial<TunnelStatus> = {}): TunnelStatus =>
  ({
    mode: 'stable',
    public_url: null,
    state: 'running',
    error: null,
    config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
    stable: { worker_url: WORKER, quick_url: QUICK, link: 'linked', error: null },
    ...over,
  }) as TunnelStatus;
const devInfo = { tunnelUrl: QUICK, bridgeProxyUrl: `${QUICK}/bridge`, localUrl: 'http://127.0.0.1:17421', pwaUrl: 'http://127.0.0.1:17421' } as never;

describe('which address the QR code carries', () => {
  it('permanent: the Worker, when it is linked', () => {
    const a = resolvePhoneAddress(devInfo, null, 5173, status());
    expect(a.source).toBe('stable');
    expect(a.origin).toBe(WORKER);
    expect(a.bridgeUrl).toBe(`${WORKER}/bridge`);
  });

  it('temporary: the plain quick address, used directly (no Worker in the code), while the Worker setting stays', () => {
    const a = resolvePhoneAddress(devInfo, null, 5173, status({ link_temporary: true }));
    expect(a.source).not.toBe('stable');
    expect(a.origin).toBe(QUICK);
    expect(a.bridgeUrl).toBe(`${QUICK}/bridge`);
    expect(a.blocked).toBeNull();
  });

  it('an own-domain Worker works the same way', () => {
    const own = 'https://phone.example.com';
    const a = resolvePhoneAddress(
      devInfo,
      null,
      5173,
      status({ config: { mode: 'stable', hostname: null, url: own, has_token: false, has_secret: true }, stable: { worker_url: own, quick_url: QUICK, link: 'linked', error: null } } as Partial<TunnelStatus>),
    );
    expect(a.origin).toBe(own);
  });
});
