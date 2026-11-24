// @vitest-environment jsdom
// The far PC's "Show terminals" is turned on while the New agent page is already open: the Terminal | Chat choice follows (it did not,
// the page read the flag once, so the toggle stayed hidden until the page was reopened).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PcLinkClient } from './pclink';
import { REMOTE_TERMINALS_POLL_MS, useRemoteNewAgent } from './remoteNewAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.useRealTimers());

describe('useRemoteNewAgent', () => {
  it('reads the far terminals switch again while open', async () => {
    vi.useFakeTimers();
    let terminals = false;
    const client = { node: 'n', agentOptions: vi.fn(async () => ({ agents: [], projects: [], terminals })) } as unknown as PcLinkClient;
    const deps = { client, node: 'n', deviceName: 'Box', canControl: () => true, onStarted: () => {} };
    let seen: boolean | undefined;
    const Probe = () => {
      seen = useRemoteNewAgent(deps).remote?.terminals;
      return null;
    };
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(seen).toBe(false);
    terminals = true;
    await act(async () => void (await vi.advanceTimersByTimeAsync(REMOTE_TERMINALS_POLL_MS + 10)));
    expect(seen).toBe(true);
    act(() => root.unmount());
  });
});
