// @vitest-environment jsdom
// P4a: Ask aside, Share, Hand off, closed chats and chat search on a chat of another PC. Each goes through the far host to the far call
// table (`pclink/calls.rs`, the `P4a` block); this PC only draws, and saves a shared chat with its own Save dialog.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { chatExportFor } from '../chatExport';
import { searchChatsEverywhere } from '../chatSearch';
import { closedChatsAcross, type ClosedChatsApi } from '../closedChats';
import { sideQuestionApi } from '../sideQuestion';
import { makePcLinkClient } from '../runtime/pclink';
import { FAR_CALLS, farHost } from './far';
import { farHandoffDeps } from './farHandoff';
import { localHost } from './local';

const KEY = `dev:${NODE_MAC}:p1`;

function setup() {
  const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
  f.farLevels[NODE_MAC] = 'full';
  const request = vi.spyOn(f, 'request');
  const client = makePcLinkClient(NODE_MAC, f);
  return { f, request, client, host: farHost(client, f, { name: 'Mac mini', calls: new Set([...FAR_CALLS].filter((c) => c !== 'pane_open_bundle')) }) };
}

beforeEach(() => {
  invokeMock.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

describe('the P4a rows', () => {
  it('every command of the Rust P4a block is a far call this host answers, so no control is drawn disabled for want of a row', () => {
    const rust = readFileSync(join(__dirname, '../../../src-tauri/crates/pm-core/src/device_link/pclink/calls.rs'), 'utf8');
    const block = rust.slice(rust.indexOf('// ---- P4a'), rust.indexOf('// ---- end P4a'));
    const rows = [...block.matchAll(/^\s*\("([a-z_]+)",/gm)].map((m) => m[1]);
    expect(rows).toHaveLength(14);
    for (const row of rows) expect(FAR_CALLS.has(row), row).toBe(true);
  });
});

describe('Ask aside', () => {
  it('asks the far PC with the same args as a local ask, the pane id turned into that PC\'s own', async () => {
    const { host, request } = setup();
    request.mockResolvedValue({ status: 200, body: { answer: 'a' } } as never);
    const ask = { ask_id: 'x', question: 'q', context: 'c' };
    await sideQuestionApi(host).ask(KEY, ask);
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/side_question_ask', { paneId: 'p1', request: ask });
    await sideQuestionApi(localHost).ask('p1', ask);
    expect(invokeMock).toHaveBeenCalledWith('side_question_ask', { paneId: 'p1', request: ask });
  });
});

describe('Share', () => {
  it('a far chat is made there and kept and saved here: the shell fetches it, the window sends no text', async () => {
    const { host } = setup();
    invokeMock.mockResolvedValue({ html: '<p>hi</p>', token: 't1' });
    const api = chatExportFor(host);
    expect(await api.html(KEY)).toEqual({ html: '<p>hi</p>', token: 't1' });
    invokeMock.mockResolvedValue({ markdown: '# hi', token: 't2' });
    expect(await api.markdown(KEY)).toEqual({ markdown: '# hi', token: 't2' });
    expect(invokeMock.mock.calls).toEqual([
      ['devices_chat_export', { node: NODE_MAC, pane_id: 'p1', markdown: false }],
      ['devices_chat_export', { node: NODE_MAC, pane_id: 'p1', markdown: true }],
    ]);
    // The save is this PC's own: a token and a path from the Save dialog, never text.
    invokeMock.mockResolvedValue('C:/x/chat.html');
    await api.save('t1', 'C:/x/chat.html');
    expect(invokeMock).toHaveBeenLastCalledWith('chat_export_save', { token: 't1', path: 'C:/x/chat.html' });
    // This PC's own chat takes the usual commands.
    invokeMock.mockReset().mockResolvedValue({ html: '', token: 't' });
    await chatExportFor(localHost).html('p1');
    expect(invokeMock).toHaveBeenCalledWith('chat_export_html', { paneId: 'p1', title: null });
  });
});

describe('closed chats across places', () => {
  const chat = (id: string, updated_ms: number) => ({ id, agent: 'claude', label: 'Claude', cwd: 'site', updated_ms, title: null });
  const localApi = (): ClosedChatsApi => ({ list: async () => [chat('c-local', 10)], reopen: vi.fn(async (id) => id), remove: vi.fn(async () => {}), removeAll: vi.fn(async () => 1), watch: async () => () => {} });

  it('lists this PC and the far PC newest first, a far chat under its key with its PC\'s name, and reopen goes to the PC that owns it', async () => {
    const { host, request } = setup();
    request.mockImplementation((async (_node: string, _method: string, path: string, body?: unknown) => {
      if (path.endsWith('acp_closed_list')) return { status: 200, body: [chat('far1', 20)] };
      if (path.endsWith('acp_reopen_closed')) return { status: 200, body: (body as { id: string }).id };
      return { status: 200, body: null };
    }) as never);
    const local = localApi();
    const all = closedChatsAcross(local, [host]);
    const list = await all.list();
    expect(list.map((c) => [c.id, c.where])).toEqual([[`dev:${NODE_MAC}:far1`, 'Mac mini'], ['c-local', undefined]]);
    expect(await all.reopen(`dev:${NODE_MAC}:far1`)).toBe(`dev:${NODE_MAC}:far1`);
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/acp_reopen_closed', { id: 'far1' });
    await all.reopen('c-local');
    expect(local.reopen).toHaveBeenCalledWith('c-local');
    await all.remove(`dev:${NODE_MAC}:far1`);
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/acp_delete_closed', { id: 'far1' });
    // "Delete all" takes every place's chats: this PC's call, then each far chat one by one on its own PC.
    request.mockClear();
    expect(await all.removeAll()).toBe(2);
    expect(local.removeAll).toHaveBeenCalled();
    expect(request.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['/pclink/call/acp_closed_list', {}],
      ['/pclink/call/acp_delete_closed', { id: 'far1' }],
    ]);
  });

  it('Delete all: a far PC that refuses a delete (below Full) keeps its chat, this PC\'s chats still go, and the refusal is raised', async () => {
    const { host, request } = setup();
    request.mockImplementation((async (_n: string, _m: string, path: string) => (path.endsWith('acp_closed_list') ? { status: 200, body: [chat('far1', 20)] } : { status: 403, body: { error: 'no', code: 'DEVICE_NOT_ALLOWED' } })) as never);
    const local = localApi();
    await expect(closedChatsAcross(local, [host]).removeAll()).rejects.toThrow();
    expect(local.removeAll).toHaveBeenCalled();
  });

  it('a far PC that does not answer adds nothing and the list still shows this PC\'s chats; with no far PC it is the same object', async () => {
    const { host, request } = setup();
    request.mockRejectedValue(new Error('offline'));
    const local = localApi();
    expect((await closedChatsAcross(local, [host]).list()).map((c) => c.id)).toEqual(['c-local']);
    expect(closedChatsAcross(local, [])).toBe(local);
  });
});

describe('chat search across places', () => {
  const hit = (paneId: string, atMs: number) => ({ paneId, session: 's', itemId: 'i', kind: 'user', agent: 'claude', folder: 'site', atMs, snippet: 'x', marks: [] });

  it('merges the far hits under their pane keys with the PC\'s name, newest first, and never as an imported chat', async () => {
    const { host, request } = setup();
    invokeMock.mockResolvedValue({ enabled: true, hits: [hit('p9', 5)] });
    request.mockResolvedValue({ status: 200, body: { enabled: true, hits: [{ ...hit('p1', 50), imported: true }] } } as never);
    const answer = await searchChatsEverywhere([host], 'x', 30, { agent: 'claude' });
    expect(answer.hits.map((h) => [h.paneId, h.where, h.imported])).toEqual([[`dev:${NODE_MAC}:p1`, 'Mac mini', false], ['p9', undefined, undefined]]);
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/chat_search', { query: 'x', limit: 30, filters: { agent: 'claude' } });
  });

  it('one PC failing never fails the search', async () => {
    const { host, request } = setup();
    invokeMock.mockResolvedValue({ enabled: true, hits: [hit('p9', 5)] });
    request.mockRejectedValue(new Error('offline'));
    expect((await searchChatsEverywhere([host], 'x')).hits.map((h) => h.paneId)).toEqual(['p9']);
  });
});

describe('Hand off on a far chat', () => {
  it('every step goes to the far PC under the pane\'s own id, and the second agent starts there on the same project', async () => {
    const { host, client, request } = setup();
    request.mockImplementation((async (_n: string, _m: string, path: string) => {
      if (path.endsWith('handoff_quick_prepare')) return { status: 200, body: { stamp: 's', path: '/x/.potato/handoffs/handoff-s.md' } };
      if (path.endsWith('/agents/start')) return { status: 200, body: { pane_id: 'p77' } };
      return { status: 200, body: { exists: true, modifiedMs: 1, bytes: 2 } };
    }) as never);
    const select = vi.fn();
    const deps = farHandoffDeps(host, client, [{ key: KEY, agent: 'claude', project: 'pabc', status: 'idle' }], select, () => undefined);
    expect(deps.pane(KEY)).toMatchObject({ lane: 'acp', cwd: 'pabc', agentType: 'claude' });
    // A chat just started there is not in the list yet: still a chat.
    expect(deps.pane(`dev:${NODE_MAC}:p77`)).toMatchObject({ lane: 'acp', status: 'idle' });
    await deps.quick.prepare(KEY, 's');
    await deps.stat(KEY, 's');
    await deps.quick.appendNotes(KEY, undefined, 'n');
    await deps.quick.archive(KEY, 's');
    expect(request.mock.calls.map((c) => [c[2], c[3]])).toEqual([
      ['/pclink/call/handoff_quick_prepare', { paneId: 'p1', stamp: 's' }],
      ['/pclink/call/handoff_file_stat', { paneId: 'p1', stamp: 's' }],
      ['/pclink/call/handoff_quick_append', { paneId: 'p1', stamp: null, notes: 'n' }],
      ['/pclink/call/handoff_quick_archive', { paneId: 'p1', stamp: 's' }],
    ]);
    expect(await deps.startChat('claude', 'pabc')).toBe(`dev:${NODE_MAC}:p77`);
    expect(request).toHaveBeenLastCalledWith(NODE_MAC, 'POST', '/pclink/agents/start', { agent: 'claude', project: 'pabc', lane: 'chat' });
    expect(await deps.quick.account(KEY)).toBeNull();
    await expect(deps.startTerminalChat('claude', 'pabc')).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a far TERMINAL agent hands off too: the brief is typed into it, the second agent is another terminal agent there, and its status is read live while the walk waits', async () => {
    const { host, client, request } = setup();
    const status = { value: 'running' };
    request.mockImplementation((async (_n: string, _m: string, path: string) => {
      if (path.endsWith('/agents/start')) return { status: 200, body: { pane_id: 'p88' } };
      if (path.endsWith('list_panes')) return { status: 200, body: [{ id: 'p1', status: status.value }] };
      return { status: 200, body: {} };
    }) as never);
    const select = vi.fn();
    const deps = farHandoffDeps(host, client, [{ key: KEY, agent: 'claude', project: 'pabc', status: 'idle', chat: false }], select, () => undefined);
    // Not a chat lane: the walk takes its terminal branch; its status is the live one once the list was read again.
    expect(deps.pane(KEY)).toMatchObject({ agentType: 'claude', cwd: 'pabc', status: 'idle' });
    expect(deps.pane(KEY)?.lane).toBeUndefined();
    await deps.sleep(0);
    expect(deps.pane(KEY)?.status).toBe('running');
    // A terminal just started there is not listed yet: it is a terminal too, and it opens on this screen.
    expect(deps.pane(`dev:${NODE_MAC}:p88`)?.lane).toBeUndefined();
    expect(await deps.startTerminal('claude', 'pabc')).toBe(`dev:${NODE_MAC}:p88`);
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/agents/start', { agent: 'claude', project: 'pabc', lane: 'terminal' });
    expect(select).toHaveBeenCalledWith(`dev:${NODE_MAC}:p88`);
    await deps.send(KEY, 'write the handoff');
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/pane_message_send', { paneId: 'p1', text: 'write the handoff' });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
