// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, isDeviceMarkedOffline, isOfflineSignal, isPollFailure, jittered, OFFLINE_RECHECK_MS, pollWithBackoff, POLL_MAX_MS, resetPollState } from './pollWithBackoff';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('backoffDelay', () => {
  it('doubles from the normal delay and caps at 60 s', () => {
    expect([0, 1, 2, 3].map((n) => backoffDelay(n, 3000))).toEqual([3000, 6000, 12_000, 24_000]);
    expect(backoffDelay(5, 3000)).toBe(POLL_MAX_MS);
    expect(backoffDelay(50, 3000)).toBe(POLL_MAX_MS);
  });
  it('jitters within 20 percent', () => {
    expect(jittered(1000, 0)).toBe(800);
    expect(jittered(1000, 1)).toBe(1200);
  });
  it('classifies failures', () => {
    expect(isPollFailure(new Error('network'))).toBe(true);
    expect(isPollFailure({ status: 429 })).toBe(true);
    expect(isPollFailure({ status: 530 })).toBe(true);
    expect(isPollFailure({ status: 403 })).toBe(false);
    expect(isOfflineSignal({ status: 502 })).toBe(true);
    expect(isOfflineSignal({ status: 429 })).toBe(false);
  });
});

describe('pollWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    resetPollState();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('doubles after failures and resets on success', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const stop = pollWithBackoff({ route: 'a', normalMs: 1000, run });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 2000 after the first failure
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); // then 4000
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); // success: back to normal
    expect(run).toHaveBeenCalledTimes(4);
    stop();
  });

  it('never waits more than 60 s', async () => {
    const run = vi.fn().mockRejectedValue(new Error('x'));
    const stop = pollWithBackoff({ route: 'b', normalMs: 10_000, run });
    await vi.advanceTimersByTimeAsync(10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    expect(run).toHaveBeenCalledTimes(5);
    stop();
  });

  it('pauses while hidden and resumes on visibilitychange', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = pollWithBackoff({ route: 'c', normalMs: 1000, run });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('treats a 5xx as offline: marks the node and rechecks once a minute', async () => {
    const run = vi.fn().mockRejectedValue({ status: 530 });
    const stop = pollWithBackoff({ node: 'n1', route: 'd', normalMs: 1000, run });
    await flush();
    expect(isDeviceMarkedOffline('n1')).toBe(true);
    await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps one request in flight per route', async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const a = pollWithBackoff({ node: 'n', route: 'same', normalMs: 100, run });
    const b = pollWithBackoff({ node: 'n', route: 'same', normalMs: 100, run });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    a();
    b();
  });

  it('stops when run says stop', async () => {
    const run = vi.fn().mockResolvedValue('stop');
    pollWithBackoff({ route: 'e', normalMs: 100, run });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
