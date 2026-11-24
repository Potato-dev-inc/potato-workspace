import { describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { farHost, FAR_CALLS } from './far';
import { PcLinkError, type PcLinkClient } from '../runtime/pclink';

useEnglish();

const OPEN = ['pane_git_branch', 'pane_worktree', 'checkpoints_list', 'artifacts_sync', 'pane_usage'] as const;
const PARTS = { pane_git_branch: 'main', pane_worktree: null, checkpoints_list: { items: [] }, artifacts_sync: [], pane_usage: { tokens: 1 } };

function setup(bundle: (args: unknown) => unknown, events: object = {}, node = 'n1') {
  const call = vi.fn(async (cmd: string, args?: unknown) => (cmd === 'pane_open_bundle' ? bundle(args) : `single:${cmd}`));
  const client = { node, call, me: async () => ({}) } as unknown as PcLinkClient;
  return { call, host: farHost(client, events as never, { name: 'far' }) };
}
const opens = (call: ReturnType<typeof vi.fn>) => call.mock.calls.filter(([c]) => c === 'pane_open_bundle').length;

describe('a far chat opens with one bundle', () => {
  it('answers the five per-chat reads from one call, each as the single call would, with the far id', async () => {
    const { call, host } = setup(() => ({ parts: { ...PARTS } }));
    const got = await Promise.all(OPEN.map((c) => host.invoke(c, { paneId: 'dev:n1:a' })));
    expect(got).toEqual(OPEN.map((c) => PARTS[c]));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('pane_open_bundle', { paneId: 'a' });
    // A later poll is the one call, not five.
    expect(await host.invoke('pane_git_branch', { paneId: 'dev:n1:a' })).toBe('single:pane_git_branch');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('a part the far PC left out (its level, or a failure) is asked on its own, so the person sees that call\'s own answer', async () => {
    const { call, host } = setup(() => ({ parts: { pane_usage: { tokens: 1 } } }));
    expect(await host.invoke('pane_usage', { paneId: 'dev:n1:a' })).toEqual({ tokens: 1 });
    expect(await host.invoke('checkpoints_list', { paneId: 'dev:n1:a' })).toBe('single:checkpoints_list');
    expect(opens(call)).toBe(1);
  });

  it('an old far PC with no such row (the table says so, or it answers unknown route) falls back to the single calls and is not asked again', async () => {
    const old = setup(() => ({ parts: { ...PARTS } }));
    const oldHost = farHost({ node: 'n1', call: old.call, me: async () => ({}) } as unknown as PcLinkClient, {} as never, { name: 'far', calls: new Set([...FAR_CALLS].filter((c) => c !== 'pane_open_bundle')) });
    expect(await oldHost.invoke('pane_usage', { paneId: 'dev:n1:a' })).toBe('single:pane_usage');
    expect(opens(old.call)).toBe(0);

    const { call, host } = setup(() => {
      throw new PcLinkError(404, { code: 'UNKNOWN_ROUTE' }, 'POST', '/pclink/call/pane_open_bundle');
    });
    expect(await host.invoke('pane_usage', { paneId: 'dev:n1:a' })).toBe('single:pane_usage');
    expect(await host.invoke('pane_git_branch', { paneId: 'dev:n1:b' })).toBe('single:pane_git_branch');
    expect(opens(call)).toBe(1);
  });

  it('only the plain per-chat form is bundled (a call with other arguments goes by itself)', async () => {
    const { call, host } = setup(() => ({ parts: { ...PARTS } }));
    expect(await host.invoke('pane_usage', { paneId: 'dev:n1:a', extra: 1 })).toBe('single:pane_usage');
    expect(opens(call)).toBe(0);
  });
});

describe('a far chat open asks once even when its host is made again', () => {
  it('two hosts of one PC (the level arrived) share one bundle and one message list', async () => {
    const events = {};
    const a = setup(() => ({ parts: { ...PARTS } }), events);
    const b = farHost({ node: 'n1', call: a.call, me: async () => ({}) } as unknown as PcLinkClient, events as never, { name: 'far' });
    const open = async (h: typeof b) => Promise.all([...OPEN.map((c) => h.invoke(c, { paneId: 'dev:n1:a' })), h.invoke('pane_messages_list', { paneId: 'dev:n1:a' })]);
    const first = await open(a.host);
    await new Promise((r) => setTimeout(r, 40));
    const second = await open(b);
    expect(second.slice(0, 5)).toEqual(first.slice(0, 5));
    const n = (c: string) => a.call.mock.calls.filter(([x]) => x === c).length;
    expect(n('pane_open_bundle')).toBe(1);
    expect(n('pane_messages_list')).toBe(1);
  });
});

describe('reads with no chat in them are shared by every chat of one PC', () => {
  it('the usage bar, the model list and the closed chats are asked once for two chats', async () => {
    const events = {};
    const a = setup(() => ({ parts: {} }), events);
    const client = { node: 'n1', call: a.call, me: async () => ({}) } as unknown as PcLinkClient;
    const b = farHost(client, events as never, { name: 'far' });
    for (const cmd of ['usage_snapshot', 'agent_default_models', 'agent_rules_effective', 'acp_closed_list']) {
      await Promise.all([a.host.invoke(cmd), b.invoke(cmd)]);
      await b.invoke(cmd);
    }
    expect(a.call).toHaveBeenCalledTimes(4);
  });
  it('another PC does not share them', async () => {
    const events = {};
    const a = setup(() => ({}), events, 'n1');
    const b = setup(() => ({}), events, 'n2');
    await a.host.invoke('usage_snapshot');
    await b.host.invoke('usage_snapshot');
    expect(a.call).toHaveBeenCalledTimes(1);
    expect(b.call).toHaveBeenCalledTimes(1);
  });
});
