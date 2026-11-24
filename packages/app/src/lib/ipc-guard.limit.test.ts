// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardInvoke, isAbort, isWrite, leavePane, MAX_INFLIGHT, queuedInvokes, resetIpcGuard, setActivePane } from './ipc-guard';

afterEach(() => {
  vi.useRealTimers();
  resetIpcGuard();
});

interface Started {
  cmd: string;
  args: unknown;
  done: () => void;
}
const reads = () => {
  const started: Started[] = [];
  let live = 0;
  let peak = 0;
  const inner = vi.fn((cmd: string, args?: unknown) => {
    live++;
    peak = Math.max(peak, live);
    return new Promise<unknown>((r) =>
      started.push({
        cmd,
        args,
        done: () => {
          live--;
          r(1);
        },
      }),
    );
  });
  return { inner, started, peak: () => peak };
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const fill = (call: ReturnType<typeof guardInvoke>) => {
  for (let i = 0; i < MAX_INFLIGHT; i++) void call('items_list', { i });
};

describe('ipc guard: the global limit', () => {
  it('runs at most 16 reads together and starts the rest in order as slots free', async () => {
    const { inner, started, peak } = reads();
    const call = guardInvoke(inner);
    for (let i = 0; i < 40; i++) void call('items_list', { i });
    expect(started).toHaveLength(MAX_INFLIGHT);
    expect(queuedInvokes()).toBe(24);
    started[0]!.done();
    started[1]!.done();
    await settle();
    expect(started.slice(16).map((s) => (s.args as { i: number }).i)).toEqual([16, 17]);
    let next = 2;
    while (started.length < 40 || next < started.length) {
      if (next < started.length) started[next++]!.done();
      await settle();
    }
    expect(started.map((s) => (s.args as { i: number }).i)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(peak()).toBeLessThanOrEqual(MAX_INFLIGHT);
  });

  it('never holds writes behind reads, and tells reads from writes by name', () => {
    const { inner, started } = reads();
    const call = guardInvoke(inner);
    for (let i = 0; i < 30; i++) void call('items_list', { i });
    void call('pane_message_send', { text: 'hi' });
    void call('plugin:window|set_title', {});
    expect(started.map((s) => s.cmd).slice(-2)).toEqual(['pane_message_send', 'plugin:window|set_title']);
    expect(['pane_message_send', 'kill_pane_cmd', 'plugin:event|emit', 'checkpoint_put_back', 'spawn_pane'].every(isWrite)).toBe(true);
    expect(['plugin:store|get', 'plugin:event|listen', 'lend_state', 'keep_going_lineage', 'branch_lineage', 'pane_git_branch', 'acp_chat_state', 'budget_for_pane'].some(isWrite)).toBe(false);
  });

  it('reads a far call by the command in its path', () => {
    const { inner, started } = reads();
    const call = guardInvoke(inner);
    fill(call);
    void call('devices_request', { node: 'n', method: 'POST', path: '/pclink/call/pane_message_send', body: {} });
    expect(started.at(-1)!.cmd).toBe('devices_request');
  });

  it('joins identical reads that are still waiting in the queue', () => {
    const { inner } = reads();
    const call = guardInvoke(inner);
    fill(call);
    const a = call('items_list', { same: 1 });
    const b = call('items_list', { same: 1 });
    expect(a).toBe(b);
    expect(queuedInvokes()).toBe(1);
  });
});

describe('ipc guard: leaving a chat', () => {
  it('drops a queued open-read for the chat that was left, and sends the others', async () => {
    const { inner, started } = reads();
    const call = guardInvoke(inner);
    fill(call);
    setActivePane('a');
    const gone = call('branch_lineage', { paneId: 'a' });
    const gone2 = call('acp_chat_state', { paneId: 'a' });
    setActivePane('b');
    void call('branch_lineage', { paneId: 'b' });
    void call('acp_chat_state', { paneId: 'x' });
    await expect(gone).rejects.toSatisfy(isAbort);
    await expect(gone2).rejects.toSatisfy(isAbort);
    expect(queuedInvokes()).toBe(2);
    started.splice(0).forEach((s) => s.done());
    await settle();
    const sent = inner.mock.calls.map((c) => c[1]);
    expect(sent).toContainEqual({ paneId: 'b' });
    expect(sent).toContainEqual({ paneId: 'x' });
    expect(sent).not.toContainEqual({ paneId: 'a' });
  });

  it('drops a queued read whose signal was aborted, and strips the signal before the real call', async () => {
    const { inner, started } = reads();
    const call = guardInvoke(inner);
    fill(call);
    const ctl = new AbortController();
    const dropped = call('items_list', { z: 1 }, { signal: ctl.signal });
    void call('items_list', { y: 1 }, { signal: new AbortController().signal, headers: {} });
    ctl.abort();
    started.splice(0).forEach((s) => s.done());
    await settle();
    await expect(dropped).rejects.toSatisfy(isAbort);
    const sentCall = inner.mock.calls.find((c) => (c[1] as { y?: number }).y) as unknown as unknown[];
    expect(sentCall[2]).toEqual({ headers: {} });
  });

  it('leaving a chat that is no longer the one on screen changes nothing', async () => {
    const { inner } = reads();
    const call = guardInvoke(inner);
    fill(call);
    setActivePane('b');
    const p = call('branch_lineage', { paneId: 'b' });
    leavePane('a');
    expect(queuedInvokes()).toBe(1);
    leavePane('b');
    await expect(p).rejects.toSatisfy(isAbort);
    expect(queuedInvokes()).toBe(0);
  });

  it('a far chat open (devices_request) is dropped the same way', async () => {
    const { inner } = reads();
    const call = guardInvoke(inner);
    fill(call);
    setActivePane('dev:n1:abc');
    const p = call('devices_request', { node: 'n1', method: 'POST', path: '/pclink/call/acp_chat_state', body: { paneId: 'abc' } });
    setActivePane('dev:n1:def');
    await expect(p).rejects.toSatisfy(isAbort);
  });
});

describe('ipc guard: 180 chat switches with no gap', () => {
  it('never has more than 16 reads in flight and never sends the open-reads of a chat already left', async () => {
    const { inner, started, peak } = reads();
    const call = guardInvoke(inner);
    const OPEN = ['branch_lineage', 'artifacts_sync', 'budget_for_pane', 'keep_going_lineage', 'pane_messages_list', 'get_pane_remote', 'acp_chat_state', 'pane_git_branch', 'pane_worktree'];
    const results: Promise<unknown>[] = [];
    const swallow = (p: Promise<unknown>) => p.catch((e) => (isAbort(e) ? 'cancelled' : Promise.reject(e)));
    for (let n = 0; n < 180; n++) {
      const id = `chat${n % 6}`;
      setActivePane(id);
      for (const cmd of OPEN) results.push(swallow(call(cmd, { paneId: id, n })));
      results.push(swallow(call('canary_status')), swallow(call('collision_list')));
      // the desktop answers a few per switch, slower than the switching
      for (const s of started.splice(0, 3)) s.done();
      await settle();
    }
    setActivePane('final');
    while (started.length || queuedInvokes()) {
      started.splice(0).forEach((s) => s.done());
      await settle();
    }
    const out = await Promise.all(results);
    expect(peak()).toBeLessThanOrEqual(MAX_INFLIGHT);
    expect(out.filter((r) => r === 'cancelled').length).toBeGreaterThan(300);
    expect(inner.mock.calls.filter((c) => c[0] === 'branch_lineage').length).toBeLessThan(120);
  });
});
