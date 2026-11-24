// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { pendingInvokes, resetIpcGuard } from './ipc-guard';

// The lowest level: the real package calls window.__TAURI_INTERNALS__.invoke. The guard sits above it (via the Vite plugin).
describe('invoke from @tauri-apps/api/core', () => {
  afterEach(() => {
    resetIpcGuard();
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('is the guarded one: counted, and identical reads share one call', async () => {
    let release!: (v: string) => void;
    const low = vi.fn(() => new Promise<string>((r) => (release = r)));
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: low };
    const a = invoke('lend_state', { id: 1 });
    const b = invoke('lend_state', { id: 1 });
    expect(low).toHaveBeenCalledTimes(1);
    expect(pendingInvokes()).toBe(1);
    expect((window as unknown as { __pendingInvokes: () => number }).__pendingInvokes()).toBe(1);
    release('ok');
    expect(await a).toBe('ok');
    expect(await b).toBe('ok');
    expect(pendingInvokes()).toBe(0);
  });
});
