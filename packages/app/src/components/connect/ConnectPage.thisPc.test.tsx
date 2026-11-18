// @vitest-environment jsdom
// Connect > Devices > "This PC": the states of the first row and the rate-limit rules of Fix it, through the real page.
// Only the command layers are fakes. The page checks by itself (no "Check now"), never restarts before Cloudflare's wait is over,
// stops offering Fix it after 3 presses, and never restarts on a different key.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { TunnelStatus } from '../../lib/tauri-types';
import type { WorkerHealth } from '../../lib/worker';
import { click, settle } from '../settings/test-utils';
import { fakeTunnel, harness, makeApi, q, quick, stable, text, WORKER, type Harness } from './connect-test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined), toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"/>') } }));

let h: Harness;
beforeEach(() => {
  window.localStorage.clear();
  setLanguagePref('en', false);
  h = harness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.unmount();
});

const state = () => q('[data-testid="connect-relay"]')!.getAttribute('data-state');
const fix = () => q<HTMLButtonElement>('[data-testid="connect-relay-fix"]');
const problem = () => text('[data-testid="connect-relay-problem-text"]');
const SENTENCE = "Your phone and other PCs can't reach this PC.";

describe('This PC: the states', () => {
  it('not set up: one button, and the setup runs from it (the row says it is setting up)', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(state()).toBe('none');
    await click(q('[data-testid="relay-set-up"]'));
    await settle(4);
    expect(state()).toBe('setting-up');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Setting this up…');
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('getting ready, then working: plain words, the link and Copy', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linking')).api }));
    expect(state()).toBe('starting');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Getting ready…');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(state()).toBe('working');
    expect(text('[data-testid="connect-relay-status"]')).toBe('Works anywhere');
  });

  it('the page checks by itself: a link that is ready on paper but cannot be reached shows as broken', async () => {
    const t = fakeTunnel(stable('linked'), undefined, { test: async () => ({ ok: false, url: WORKER, http_status: 0, latency_ms: 0, message: 'no' }) });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe(SENTENCE);
    expect(q('[data-testid="relay-menu-check"]')).toBeNull();
  });

  it('there is no Check now, no menu, no used-by line, no relay options', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(q('[data-testid="connect-relay-menu"]')).toBeNull();
    expect(q('[data-testid="connect-relay-used"]')).toBeNull();
    expect(q('[data-testid="connect-relay-options"]')).toBeNull();
    expect(q('[data-testid="connect-relay-checked"]')).toBeNull();
  });

  it('Copy copies the link and says Copied', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => (writes.push(s), undefined) }, configurable: true });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    await click(q('[data-testid="relay-menu-copy"]'));
    await settle(4);
    expect(writes).toEqual([WORKER]);
    expect(text('[data-testid="relay-menu-copy"]')).toBe('Copied');
  });
});

describe('This PC: Fix it keeps the rate-limit rules', () => {
  it('broken: one sentence and Fix it, which restarts WITHOUT trying anyway', async () => {
    const args: unknown[][] = [];
    const t = fakeTunnel(stable('failed'), () => stable('linked'), {
      restart: async (...a: unknown[]) => {
        args.push(a);
        return stable('linked');
      },
    });
    await h.mount(makeApi({ tunnel: t.api }));
    expect(state()).toBe('broken');
    expect(problem()).toBe(SENTENCE);
    await click(fix());
    await settle(4);
    expect(args).toEqual([[]]);
    expect(state()).toBe('working');
  });

  it('Cloudflare asked to wait: the plain wait sentence, and Fix it is off until it ends', async () => {
    const waiting = { ...stable('failed'), problem: 'too_soon', retry_in_secs: 240 } as TunnelStatus;
    let restarts = 0;
    await h.mount(makeApi({ tunnel: fakeTunnel(waiting, undefined, { restart: async () => (restarts++, waiting) }).api }));
    expect(problem()).toBe('Cloudflare asked us to wait. Try again in about 4 min.');
    expect(fix()!.disabled).toBe(true);
    await click(fix());
    expect(restarts).toBe(0);
  });

  it('a problem word with no wait time left (the wait is over): no countdown, Fix it is on', async () => {
    const over = { ...stable('failed'), problem: 'too_soon', retry_in_secs: null } as TunnelStatus;
    await h.mount(makeApi({ tunnel: fakeTunnel(over).api }));
    expect(fix()!.disabled).toBe(false);
    expect(problem()).toBe(SENTENCE);
  });

  it('the wait counts down and Fix it turns back on when it ends (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t0 = Date.now();
    // Like the backend: every read says how much of the wait is left, and nothing once it is over.
    const read = async () => {
      const left = 60 - Math.floor((Date.now() - t0) / 1000);
      return { ...stable('failed'), problem: 'too_soon', retry_in_secs: left > 0 ? left : null } as TunnelStatus;
    };
    await h.mount(makeApi({ tunnel: fakeTunnel(await read(), undefined, { getStatus: read }).api }));
    expect(fix()!.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fix()!.disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(35_000);
    });
    expect(fix()!.disabled).toBe(false);
    expect(problem()).toBe(SENTENCE);
  });

  it('rate limited: its own sentence with the wait, button off', async () => {
    const limited = { ...stable('failed'), problem: 'rate_limited', retry_in_secs: 3600 } as TunnelStatus;
    await h.mount(makeApi({ tunnel: fakeTunnel(limited).api }));
    expect(problem()).toBe('Your network is limited for now. Try again in about 60 min.');
    expect(fix()!.disabled).toBe(true);
  });

  it('after 3 presses it stops offering Fix it and offers Set up again, which opens the setup (never a restart)', async () => {
    let restarts = 0;
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed'), undefined, { restart: async () => (restarts++, stable('failed')) }).api }));
    for (let i = 0; i < 3; i++) {
      await click(fix());
      await settle(4);
    }
    expect(restarts).toBe(3);
    expect(fix()).toBeNull();
    expect(problem()).toBe('This needs a fresh setup. Your phone will need to scan again.');
    await click(q('[data-testid="connect-relay-again"]'));
    await settle(4);
    expect(restarts).toBe(3);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });

  it('the 3 presses start over once it works again', async () => {
    let current = stable('failed');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('failed'), undefined, { getStatus: async () => current, restart: async () => current }).api }));
    for (let i = 0; i < 3; i++) {
      await click(fix());
      await settle(4);
    }
    expect(fix()).toBeNull();
    current = stable('linked');
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle(4);
    expect(state()).toBe('working');
    current = stable('failed');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle(4);
    expect(state()).toBe('broken');
    expect(fix()).not.toBeNull();
    expect(problem()).toBe(SENTENCE);
  });

  it('a different key (secret mismatch): a fresh setup is offered, a restart never happens', async () => {
    const mismatch = { ...stable('failed'), stable: { worker_url: WORKER, quick_url: null, link: 'failed', error: 'refused', secret_mismatch: true } } as TunnelStatus;
    const t = fakeTunnel(mismatch);
    await h.mount(makeApi({ tunnel: t.api }));
    expect(problem()).toBe('This needs a fresh setup. Your phone will need to scan again.');
    expect(fix()).toBeNull();
    await click(q('[data-testid="connect-relay-again"]'));
    await settle(6);
    expect(t.calls.restart).toBe(0);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
  });
});

describe('This PC: the old-link update and the languages', () => {
  const health = (features: string[]): ((a: string) => Promise<WorkerHealth | null>) => async () => ({ reachable: true, features, legacyLink: false }) as unknown as WorkerHealth;

  it('a link made before PCs could be added on other networks gets one Update button; a newer one shows nothing', async () => {
    await h.mount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, settings: { far_pcs_enabled: true }, workerHealth: health(['team', 'stable-link']) }));
    expect(text('[data-testid="connect-relay-status"]')).toContain('Works anywhere · PCs on other networks need an update.');
    await click(q('[data-testid="connect-relay-pair-update-go"]'));
    await settle(4);
    expect(q('[data-testid="relay-sheet"]')).not.toBeNull();
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api, settings: { far_pcs_enabled: true }, workerHealth: health(['team', 'stable-link', 'pair']) }));
    expect(q('[data-testid="connect-relay-pair-update-go"]')).toBeNull();
  });

  it('speaks Traditional Chinese in all three states', async () => {
    setLanguagePref('zh-TW', false);
    await h.mount(makeApi({ tunnel: fakeTunnel(quick()).api }));
    expect(text('[data-testid="relay-set-up"]')).toBe('讓它隨處可用');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('linked')).api }));
    expect(text('[data-testid="connect-relay-status"]')).toBe('隨處可用');
    await h.remount(makeApi({ tunnel: fakeTunnel(stable('failed')).api }));
    expect(problem()).toBe('你的手機和其他電腦連不到這台電腦。');
    expect(text('[data-testid="connect-relay-fix"]')).toBe('修復');
  });
});
