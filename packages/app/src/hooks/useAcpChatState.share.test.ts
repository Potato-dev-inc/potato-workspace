// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatApi } from '../lib/acpChat';
import { ACP_STATE_GRACE_MS, useAcpChatState } from './useAcpChatState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(use: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as T };
  const el = document.createElement('div');
  const root = createRoot(el);
  function P() {
    result.current = use();
    return null;
  }
  act(() => root.render(createElement(P)));
  return { result, unmount: () => act(() => root.unmount()) };
}

afterEach(() => vi.useRealTimers());

function fakeApi() {
  let push: (id: string, s: unknown) => void = () => undefined;
  const stop = vi.fn();
  const api = {
    state: vi.fn(async () => ({ phase: 'idle' }) as never),
    watch: vi.fn(async (cb: (id: string, s: never) => void) => {
      push = cb as never;
      return stop;
    }),
  } as unknown as AcpChatApi;
  return { api, stop, push: (id: string, s: unknown) => push(id, s) };
}

describe('useAcpChatState shares one store per pane', () => {
  it('two views of one pane read and listen once; the last one leaving lets go after the grace', async () => {
    vi.useFakeTimers();
    const f = fakeApi();
    const a = renderHook(() => useAcpChatState('p1', true, f.api));
    const b = renderHook(() => useAcpChatState('p1', true, f.api));
    await act(async () => {});
    expect(f.api.state).toHaveBeenCalledTimes(1);
    expect(f.api.watch).toHaveBeenCalledTimes(1);
    expect(a.result.current).toEqual({ phase: 'idle' });
    act(() => f.push('p1', { phase: 'busy' }));
    expect(b.result.current).toEqual({ phase: 'busy' });
    a.unmount();
    b.unmount();
    // A quick switch back inside the grace asks nothing again.
    const c = renderHook(() => useAcpChatState('p1', true, f.api));
    expect(f.api.state).toHaveBeenCalledTimes(1);
    expect(c.result.current).toEqual({ phase: 'busy' });
    c.unmount();
    expect(f.stop).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(ACP_STATE_GRACE_MS + 10));
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('a far host made again with the same link joins the same store', async () => {
    const f = fakeApi();
    const link = {};
    const hostOf = () => ({ place: { kind: 'pc', node: 'n1', name: 'Box' }, live: true, caps: {}, link, invoke: async () => ({ phase: 'idle' }), listen: async () => () => undefined });
    const { acpChatApi } = await import('../lib/acpChat');
    const spy = vi.spyOn(await import('../lib/acpChat'), 'acpChatApi').mockReturnValue(f.api);
    void acpChatApi;
    const { HostProvider } = await import('../lib/host/context');
    const probe = (host: never) => {
      const el = document.createElement('div');
      const root = createRoot(el);
      function P() {
        useAcpChatState('p9', true);
        return null;
      }
      act(() => root.render(createElement(HostProvider, { host, children: createElement(P) })));
      return root;
    };
    probe(hostOf() as never);
    probe(hostOf() as never);
    await act(async () => {});
    expect(f.api.state).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a far pane read with a given api and one without share one read (two consumers fired acp_chat_state twice)', async () => {
    const given = fakeApi();
    const other = fakeApi();
    const link = {};
    const host = { place: { kind: 'pc', node: 'n1', name: 'Box' }, live: true, caps: {}, link, invoke: async () => ({}), listen: async () => () => undefined };
    const spy = vi.spyOn(await import('../lib/acpChat'), 'acpChatApi').mockReturnValue(other.api);
    const { HostProvider } = await import('../lib/host/context');
    const probe = (withApi: boolean) => {
      const root = createRoot(document.createElement('div'));
      function P() {
        useAcpChatState('p8', true, withApi ? given.api : undefined);
        return null;
      }
      act(() => root.render(createElement(HostProvider, { host: host as never, children: createElement(P) })));
    };
    probe(true);
    probe(false);
    await act(async () => {});
    expect(vi.mocked(given.api.state).mock.calls.length + vi.mocked(other.api.state).mock.calls.length).toBe(1);
    spy.mockRestore();
  });
});
