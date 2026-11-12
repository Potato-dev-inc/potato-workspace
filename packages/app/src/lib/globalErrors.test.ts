// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createReporter, describeThrown, installGlobalErrorHandlers, MAX_UI_ERRORS_PER_MINUTE } from './globalErrors';

describe('createReporter', () => {
  it('sends the message and stack of a thrown error', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createReporter(send, () => 0);
    expect(report('window.onerror', new Error('boom'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ where: 'window.onerror', message: 'boom' });
    expect(send.mock.calls[0][0].stack).toContain('Error: boom');
  });

  it('lets 20 through in a minute and drops the rest, then recovers', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let t = 1000;
    const report = createReporter(send, () => t);
    for (let i = 0; i < MAX_UI_ERRORS_PER_MINUTE + 10; i++) report('x', new Error(`e${i}`));
    expect(send).toHaveBeenCalledTimes(MAX_UI_ERRORS_PER_MINUTE);
    t += 61_000;
    expect(report('x', new Error('later'))).toBe(true);
    expect(send).toHaveBeenCalledTimes(MAX_UI_ERRORS_PER_MINUTE + 1);
  });

  it('does not raise when the command is missing (rejects) or throws', async () => {
    const rejecting = createReporter(() => Promise.reject(new Error('command log_ui_error not found')), () => 0);
    expect(() => rejecting('x', 'a')).not.toThrow();
    const throwing = createReporter(() => {
      throw new Error('sync');
    }, () => 0);
    expect(() => throwing('x', 'a')).not.toThrow();
    await Promise.resolve();
  });
});

describe('describeThrown', () => {
  it('handles strings, objects and unserialisable values', () => {
    expect(describeThrown('plain').message).toBe('plain');
    expect(describeThrown({ code: 'X' }).message).toContain('"code"');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(describeThrown(loop).message).toBe('Unreadable error value');
    expect(describeThrown('y'.repeat(5000)).message.length).toBeLessThan(2100);
  });
});

describe('installGlobalErrorHandlers', () => {
  it('reports an uncaught error and an unhandled rejection, and stops when removed', () => {
    // A private event target stands in for window: synthetic events dispatched here never reach
    // window, so Vitest's jsdom error listener does not count them as real uncaught errors.
    const target = new EventTarget();
    const report = vi.fn().mockReturnValue(true);
    const off = installGlobalErrorHandlers(target, report);
    const err = new Error('thrown in a handler');
    target.dispatchEvent(new ErrorEvent('error', { error: err, message: err.message }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = 'nobody caught this';
    target.dispatchEvent(rejection);
    expect(report).toHaveBeenCalledWith('window.onerror', err);
    expect(report).toHaveBeenCalledWith('unhandledrejection', 'nobody caught this');
    off();
    target.dispatchEvent(new ErrorEvent('error', { error: err }));
    expect(report).toHaveBeenCalledTimes(2);
  });
});
