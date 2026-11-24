import { describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { farHost, FAR_CALLS } from './far';
import { farCockpit } from './farCockpit';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { PcLinkClient } from '../runtime/pclink';

useEnglish();

// The far PC answers a start with its OWN pane id; the screen must get the key (`dev:<node>:<id>`) it selects chats by,
// else `select(raw id)` is a pane of this PC that does not exist and the view falls back to the Inbox.
describe('a chat started on a far PC', () => {
  it('answers with the key of this screen, not the far PC id', async () => {
    const call = vi.fn(async () => ({ pane_id: 'acp-7', agent: 'claude', lane: 'acp' }));
    const host = farHost({ node: 'n1', call, me: async () => ({}) } as unknown as PcLinkClient, {} as never, { name: 'far', calls: new Set(FAR_CALLS) });
    expect(await host.invoke('acp_chat_start', { agentId: 'claude', folder: 'p1' })).toMatchObject({ pane_id: 'dev:n1:acp-7' });
  });
});

describe('selecting the chat just started, before the far list has caught up', () => {
  it('opens it by key on that PC; the select of this PC is never called (that one falls back to the Inbox)', async () => {
    const call = vi.fn(async () => ({ pane_id: 'acp-7' }));
    const host = farHost({ node: 'n1', call, me: async () => ({}) } as unknown as PcLinkClient, {} as never, { name: 'far', calls: new Set(FAR_CALLS) });
    const started = await host.invoke<{ pane_id: string }>('acp_chat_start', { agentId: 'claude', folder: 'p1' });
    const select = vi.fn();
    const openRow = vi.fn();
    const c = { registry: { panes: new Map(), paneList: [] }, names: new Map(), launchEntries: [], select } as unknown as CockpitApi;
    // The far list is empty: the new chat is in no row yet (its refresh arrives later).
    const ck = farCockpit(c, { node: 'n1' } as unknown as PcLinkClient, 'far', [], '', openRow);
    ck.select(started.pane_id);
    expect(openRow).toHaveBeenCalledWith('dev:n1:acp-7');
    expect(select).not.toHaveBeenCalled();
  });
});
