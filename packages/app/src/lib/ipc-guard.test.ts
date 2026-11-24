// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardInvoke, pendingByCommand, pendingInvokes, resetIpcGuard } from './ipc-guard';

afterEach(() => {
  vi.useRealTimers();
  resetIpcGuard();
});

const later = () => {
  const calls: string[] = [];
  const waiting: Array<(v: unknown) => void> = [];
  const inner = vi.fn((cmd: string) => {
    calls.push(cmd);
    return new Promise<unknown>((r) => waiting.push(r));
  });
  return { inner, calls, waiting };
};

describe('ipc guard', () => {
  it('counts calls in flight and names the busiest commands', async () => {
    const { inner, waiting } = later();
    const call = guardInvoke(inner);
    const a = call('a', {});
    void call('b', {});
    void call('b', {});
    expect(pendingInvokes()).toBe(3);
    expect(pendingByCommand()[0]).toEqual(['b', 2]);
    waiting.forEach((r) => r(1));
    await a;
    await Promise.resolve();
    expect(pendingInvokes()).toBe(0);
  });

  it('answers identical reads in flight together with one call, but never other commands', async () => {
    const { inner, waiting } = later();
    const call = guardInvoke(inner);
    const x = call('files_list', { paneId: 'p' });
    const y = call('files_list', { paneId: 'p' });
    void call('files_list', { paneId: 'q' });
    void call('pane_write', { id: 1 });
    void call('pane_write', { id: 1 });
    expect(inner).toHaveBeenCalledTimes(4);
    waiting.forEach((r) => r('ok'));
    expect(await x).toBe(await y);
  });

  it('keeps a branch answer for a second, then asks again', async () => {
    vi.useFakeTimers();
    const call = guardInvoke(async () => 'main');
    await call('pane_git_branch', { paneId: 'p' });
    await call('pane_git_branch', { paneId: 'p' });
    vi.setSystemTime(Date.now() + 1500);
    const inner = vi.fn(async () => 'dev');
    await guardInvoke(inner)('pane_git_branch', { paneId: 'p' });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not join an old read unless a backlog has built up, and warns once on a long backlog', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { inner } = later();
    const call = guardInvoke(inner);
    void call('mission_list', {});
    vi.advanceTimersByTime(400);
    void call('mission_list', {});
    expect(inner).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 600; i++) void call('pane_write', { i });
    vi.advanceTimersByTime(7000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('pane_write x600');
    warn.mockRestore();
  });
});

describe('ipc guard: store reads and the backlog valve', () => {
  it('keeps a store read for a second, and a store write (or settings_patch) drops it', async () => {
    vi.useFakeTimers();
    const inner = vi.fn(async () => 'v');
    const call = guardInvoke(inner);
    await call('plugin:store|get', { rid: 1, key: 'settings' });
    await call('plugin:store|get', { rid: 1, key: 'settings' });
    expect(inner).toHaveBeenCalledTimes(1);
    await call('plugin:store|set', { rid: 1, key: 'settings', value: 2 });
    await call('plugin:store|get', { rid: 1, key: 'settings' });
    expect(inner).toHaveBeenCalledTimes(3);
    await call('settings_patch', { patch: {} });
    await call('plugin:store|get', { rid: 1, key: 'settings' });
    expect(inner).toHaveBeenCalledTimes(5);
    vi.setSystemTime(Date.now() + 1500);
    await call('plugin:store|get', { rid: 1, key: 'settings' });
    expect(inner).toHaveBeenCalledTimes(6);
  });
});
