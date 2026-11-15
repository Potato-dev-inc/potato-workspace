// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startJoinLinkBridge, SHELL_JOIN_EVENT, type JoinBridgeDeps } from './join-link-bridge';

const DEEP = 'potato-workspace://join/ABCDEFGH23456789?w=pm-relay.maya.workers.dev';
const tick = () => new Promise((r) => setTimeout(r, 0));

function fake(pending: unknown = null) {
  const handlers: ((e: { payload: unknown }) => void)[] = [];
  const off = vi.fn();
  const takePending = vi.fn(async () => pending);
  const deps: JoinBridgeDeps = { listen: async (_n, h) => (handlers.push(h), off), takePending };
  return { deps, handlers, off, takePending };
}
const heard: unknown[] = [];
const on = (e: Event) => heard.push((e as CustomEvent).detail);
window.addEventListener('pm:join-link', on);
afterEach(() => (heard.length = 0));

describe('join link bridge', () => {
  it('announces a valid link from the shell as the pm:join-link event, and clears the shell copy', async () => {
    const f = fake();
    startJoinLinkBridge(f.deps);
    await tick();
    f.handlers[0]({ payload: DEEP });
    expect(heard).toEqual([DEEP]);
    expect(f.takePending).toHaveBeenCalledTimes(2);
  });

  it('announces a link that was waiting when the window opened', async () => {
    startJoinLinkBridge(fake(DEEP).deps);
    await tick();
    expect(heard).toEqual([DEEP]);
  });

  it('drops anything that is not an invite link', async () => {
    const f = fake('potato-workspace://open/x');
    startJoinLinkBridge(f.deps);
    await tick();
    for (const payload of [null, 7, { a: 1 }, 'https://evil.example/join/ABCDEFGH23456789', 'potato-workspace://join/BAD?w=x.example.com']) f.handlers[0]({ payload });
    expect(heard).toEqual([]);
  });

  it('stops listening when stopped, and listens to the shell event name', async () => {
    const seen: string[] = [];
    const off = vi.fn();
    const stop = startJoinLinkBridge({ listen: async (n) => (seen.push(n), off), takePending: async () => null });
    await tick();
    stop();
    expect(seen).toEqual([SHELL_JOIN_EVENT]);
    expect(off).toHaveBeenCalled();
  });

  it('does nothing outside the desktop app', () => {
    expect(() => startJoinLinkBridge()()).not.toThrow();
  });
});
