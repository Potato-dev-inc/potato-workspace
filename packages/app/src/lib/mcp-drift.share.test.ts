// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (cmd: string) => (cmd === 'mcp_tools_drift' ? [] : undefined));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: [string]) => invoke(...a) }));
import { DRIFT_SHARE_MS, mcpReconnect, mcpToolsDrift, resetDriftShare } from './mcp-drift';

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockClear();
  resetDriftShare();
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

describe('mcpToolsDrift', () => {
  it('shares one answer across screens, asks again after the window and after a reconnect', async () => {
    await Promise.all([mcpToolsDrift(), mcpToolsDrift(), mcpToolsDrift()]);
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + DRIFT_SHARE_MS + 10);
    await mcpToolsDrift();
    expect(invoke).toHaveBeenCalledTimes(2);
    await mcpReconnect('p');
    await mcpToolsDrift();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(['mcp_tools_drift', 'mcp_tools_drift', 'mcp_reconnect', 'mcp_tools_drift']);
  });
});
