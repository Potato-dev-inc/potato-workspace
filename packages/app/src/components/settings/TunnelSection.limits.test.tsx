// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import { TunnelSection, type TunnelApi } from './TunnelSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKER = 'https://potato-stable-link.me.workers.dev';
const limited = (problem: TunnelStatus['problem'], retry: number | null = null): TunnelStatus => ({
  mode: 'quick',
  public_url: null,
  state: 'error',
  error: 'raw english from the app',
  config: { mode: 'quick', hostname: null, url: null, has_token: false },
  problem,
  retry_in_secs: retry,
});

describe('TunnelSection: Cloudflare limits', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    setLanguagePref('en', false);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLanguagePref('en', false);
  });

  const api = (status: TunnelStatus): TunnelApi => ({
    getStatus: vi.fn(async () => status),
    save: vi.fn(async () => status),
    restart: vi.fn(async () => status),
    test: vi.fn(async () => ({ ok: false, url: 'u', http_status: null, latency_ms: 0, message: '' })),
  });
  const show = async (status: TunnelStatus) => {
    await act(async () => root.render(<TunnelSection api={api(status)} />));
    await act(async () => { await Promise.resolve(); });
    return host.querySelector('[data-testid="tunnel-status"]')?.textContent ?? '';
  };

  it('says the rate limit in plain words with the next step, not "Starting"', async () => {
    const text = await show(limited('rate_limited'));
    expect(text).toBe('Cloudflare is limiting new quick addresses from this network. Wait about an hour, or use your own Worker address / a named tunnel.');
  });

  it('says it in Traditional Chinese too', async () => {
    setLanguagePref('zh-TW', false);
    expect(await show(limited('rate_limited'))).toContain('Cloudflare 正在限制這個網路建立新的快速位址');
  });

  it('says a slow start and a too-soon restart (with minutes) in words', async () => {
    expect(await show(limited('slow_start'))).toContain('has not given a quick address yet');
    act(() => root.unmount());
    root = createRoot(host);
    expect(await show(limited('too_soon', 90))).toContain('Try again in about 2 min.');
  });

  it('with a Worker address the limit shows too, and the card stops polling as "still linking"', async () => {
    const status: TunnelStatus = {
      ...limited('rate_limited'),
      mode: 'stable',
      public_url: WORKER,
      config: { mode: 'stable', hostname: null, url: WORKER, has_token: false, has_secret: true },
      stable: { worker_url: WORKER, quick_url: null, link: 'waiting', error: null },
    };
    expect(await show(status)).toContain('Cloudflare is limiting new quick addresses');
    expect(host.querySelector('[data-testid="tunnel-still-linking"]')).toBeNull();
  });

  it('after a refused restart, "Try anyway" restarts once with the wait skipped; after a Cloudflare limit there is no such button', async () => {
    const a = api(limited('too_soon', 90));
    await act(async () => root.render(<TunnelSection api={a} />));
    await act(async () => { await Promise.resolve(); });
    const btn = host.querySelector<HTMLButtonElement>('[data-testid="tunnel-try-anyway"]')!;
    expect(btn.textContent).toBe('Try anyway');
    await act(async () => btn.click());
    expect(a.restart).toHaveBeenCalledWith(true);
    act(() => root.unmount());
    root = createRoot(host);
    await show(limited('rate_limited'));
    expect(host.querySelector('[data-testid="tunnel-try-anyway"]')).toBeNull();
    setLanguagePref('zh-TW', false);
    act(() => root.unmount());
    root = createRoot(host);
    await show(limited('too_soon', 90));
    expect(host.querySelector('[data-testid="tunnel-try-anyway"]')!.textContent).toBe('仍要重試');
  });
});
