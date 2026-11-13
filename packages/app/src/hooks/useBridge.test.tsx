// @vitest-environment jsdom
// "Connection lost" never shows before the first connection: an error while still connecting is not a loss.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let onEvent: (ev: { type: string }) => void = () => {};
let onError: () => void = () => {};
vi.mock('../lib/bridge', () => ({
  findBridgeUrl: async () => 'http://127.0.0.1:1',
  makeBridgeClient: () => ({}),
  subscribeBridgeEvents: (_url: string, ev: typeof onEvent, err: () => void) => {
    onEvent = ev;
    onError = err;
    return () => {};
  },
}));
vi.mock('../lib/bridge-local-secret', () => ({ loadBridgeLocalSecret: async () => {} }));

import { useBridge, type BridgeApi } from './useBridge';

describe('useBridge connectionLost', () => {
  it('stays false for an error before the first event, true after a live bridge drops, false again on the next event', async () => {
    let api!: BridgeApi;
    function Probe() {
      api = useBridge();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => {});
    act(() => onError());
    expect(api.connectionLost).toBe(false);
    act(() => onEvent({ type: 'panes', panes: [] } as never));
    act(() => onError());
    expect(api.connectionLost).toBe(true);
    act(() => onEvent({ type: 'panes', panes: [] } as never));
    expect(api.connectionLost).toBe(false);
    act(() => root.unmount());
  });
});
