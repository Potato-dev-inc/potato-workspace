// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { findBridgeUrl } from './bridge';

afterEach(() => {
  invoke.mockReset();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

describe('findBridgeUrl with POTATO_WORKSPACE_PROFILE', () => {
  it("a profile's window uses its own bridge, never the first one that answers", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue('http://127.0.0.1:17461');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await findBridgeUrl()).toBe('http://127.0.0.1:17461');
    expect(invoke).toHaveBeenCalledWith('profile_bridge_url');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the default profile (null) scans its own range from 17421, never the old 17321-17399 range', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(null);
    const fetchSpy = vi.fn(async (url: string) => ({ ok: url.includes(':17421/') }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await findBridgeUrl()).toBe('http://127.0.0.1:17421');
    expect(String(fetchSpy.mock.calls[0][0])).toContain(':17421/health');
  });

  it('scans 17421 to 17499 and nothing else when no bridge answers', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invoke.mockResolvedValue(null);
    const fetchSpy = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchSpy);
    expect(await findBridgeUrl()).toBeNull();
    const ports = fetchSpy.mock.calls.map((call) => Number(/:(\d+)\//.exec(String((call as unknown[])[0]))![1]));
    expect(Math.min(...ports)).toBe(17421);
    expect(Math.max(...ports)).toBe(17499);
    expect(ports).toHaveLength(79);
  });
});
