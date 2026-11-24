import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { farHost, FAR_CALLS, FAR_JOIN_MS } from './far';
import type { PcLinkClient } from '../runtime/pclink';

useEnglish();
afterEach(() => vi.useRealTimers());

function setup() {
  const call = vi.fn(async (cmd: string) => cmd);
  const client = { node: 'n1', call, me: async () => ({}) } as unknown as PcLinkClient;
  return { call, host: farHost(client, {} as never, { name: 'far', calls: new Set([...FAR_CALLS].filter((c) => c !== 'pane_open_bundle')) }) };
}

describe('far reads are shared', () => {
  it('joins identical reads in flight, keeps a branch for a second, and a write drops what was kept', async () => {
    vi.useFakeTimers();
    const { call, host } = setup();
    await Promise.all([host.invoke('files_marks', { paneId: 'dev:n1:a' }), host.invoke('files_marks', { paneId: 'dev:n1:a' }), host.invoke('files_marks', { paneId: 'dev:n1:b' })]);
    expect(call).toHaveBeenCalledTimes(2);
    await host.invoke('pane_git_branch', { paneId: 'dev:n1:a' });
    await host.invoke('pane_git_branch', { paneId: 'dev:n1:a' });
    expect(call).toHaveBeenCalledTimes(3);
    await host.invoke('files_write', { paneId: 'dev:n1:a' });
    await host.invoke('pane_git_branch', { paneId: 'dev:n1:a' });
    expect(call).toHaveBeenCalledTimes(5);
    vi.setSystemTime(Date.now() + FAR_JOIN_MS + 1500);
    await host.invoke('pane_git_branch', { paneId: 'dev:n1:a' });
    expect(call).toHaveBeenCalledTimes(6);
  });

  it('never joins a write', async () => {
    const { call, host } = setup();
    await Promise.all([host.invoke('pane_message_send', { paneId: 'dev:n1:a', text: 'x' }), host.invoke('pane_message_send', { paneId: 'dev:n1:a', text: 'x' })]);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
