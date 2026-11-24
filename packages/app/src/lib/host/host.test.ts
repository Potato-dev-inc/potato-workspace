// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { acpChatApi } from '../acpChat';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { makePcLinkClient } from '../runtime/pclink';
import { sayError } from '../sayError';
import { farHost } from './far';
import { localHost } from './local';
import { placeKey } from './placeKey';

describe('Host seam', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });

  it('the local host makes the same invoke calls as before', async () => {
    const api = acpChatApi(localHost);
    await api.setConfig('p1', 'model', 'opus');
    await api.cancel('p1');
    await api.setForceYes!('p1', true);
    expect(invokeMock.mock.calls).toEqual([
      ['acp_chat_set_config', { paneId: 'p1', optionId: 'model', value: 'opus' }],
      ['acp_chat_cancel', { paneId: 'p1' }],
      ['acp_chat_set_force_yes', { paneId: 'p1', on: true }],
    ]);
  });

  it('the far host sends POST /pclink/call/<cmd> with the same args', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    f.farLevels[NODE_MAC] = 'full';
    const request = vi.spyOn(f, 'request').mockResolvedValue({ status: 200, body: { configOptions: [] } } as never);
    await acpChatApi(farHost(makePcLinkClient(NODE_MAC, f), f)).setConfig('p1', 'model', 'opus');
    // No hold is claimed: the far PC asks it only of a PC that is not the person's own, and the screen has no hold control for this.
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/acp_chat_set_config', { paneId: 'p1', optionId: 'model', value: 'opus' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a hold is sent only when the screen held, and a far refusal that asks for it reads as the far PC\'s own sentence', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    f.farLevels[NODE_MAC] = 'full';
    const request = vi.spyOn(f, 'request').mockResolvedValue({ status: 200, body: {} } as never);
    const host = farHost(makePcLinkClient(NODE_MAC, f), f);
    await host.invoke('acp_chat_set_force_yes', { paneId: 'p1', on: true });
    await host.invoke('acp_chat_set_force_yes', { paneId: 'p1', on: true, hold: true });
    expect(request.mock.calls.map((c) => c[3])).toEqual([{ paneId: 'p1', on: true }, { paneId: 'p1', on: true, hold: true }]);
    request.mockResolvedValue({ status: 409, body: { code: 'NEEDS_HOLD', error: 'Allow it on that PC itself.' } } as never);
    await expect(host.invoke('acp_chat_set_force_yes', { paneId: 'p1', on: true })).rejects.toThrow('Allow it on that PC itself.');
  });

  it('a far refusal keeps its code (a file conflict is still told apart) and a reply with no sentence never shows the raw request', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    f.farLevels[NODE_MAC] = 'full';
    const request = vi.spyOn(f, 'request');
    const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
    request.mockResolvedValue({ status: 400, body: { code: 'FILES_CONFLICT', error: 'That file changed on the disk.' } } as never);
    const conflict = await host.invoke('files_write', { paneId: 'p1' }).catch((e: unknown) => e);
    expect(sayError(conflict).details).toContain('Code: FILES_CONFLICT');
    expect(sayError(conflict).text).toBe('That file changed on the disk.');
    request.mockResolvedValue({ status: 502, body: {} } as never);
    await expect(host.invoke('files_write', { paneId: 'p1' })).rejects.toThrow('Could not reach that PC.');
    request.mockResolvedValue({ status: 404, body: { code: 'UNKNOWN_ROUTE', error: 'not found' } } as never);
    await expect(host.invoke('files_write', { paneId: 'p1' })).rejects.toThrow('Not on Mac mini yet.');
  });

  it('the message box and the feed ride the call rows and the app frames: send, then the items frame under the pane key', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    f.farLevels[NODE_MAC] = 'answer';
    const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
    const key = 'dev:' + NODE_MAC + ':p1';
    for (const cmd of ['session_chat_open', 'session_chat_close', 'chat_earlier', 'chat_picture', 'acp_chat_cancel', 'pane_message_send', 'pane_message_cancel', 'pane_message_hold', 'pane_message_edit', 'pane_messages_list', 'acp_chat_keep_waiting', 'acp_chat_take_back', 'acp_chat_set_auto_allow', 'acp_chat_set_agent_answering', 'acp_chat_warm']) {
      expect(host.can!(cmd), cmd).toBe(true);
    }
    const items: { items: { text: string }[] }[] = [];
    const queues: { messages: unknown[] }[] = [];
    const offItems = await host.listen('session-chat-items', (p: { items: { text: string }[] }) => items.push(p));
    const offQueue = await host.listen('pane-outbox', (p: { messages: unknown[] }) => queues.push(p));
    const sent = await host.invoke<{ id: string; text: string }>('pane_message_send', { paneId: key, text: 'go on' });
    await Promise.resolve();
    offItems();
    offQueue();
    expect(sent.text).toBe('go on');
    expect(f.farCalls.at(-1)).toEqual({ cmd: 'pane_message_send', args: { paneId: 'p1', text: 'go on' } });
    expect(items).toEqual([{ paneId: key, items: [expect.objectContaining({ text: 'go on' })], reset: false }]);
    expect(queues[0]!.messages).toHaveLength(1);
    expect(await host.invoke('pane_messages_list', { paneId: key })).toHaveLength(1);
    // Answer may send but not change the agent's settings: the far PC refuses with the general sentence.
    await expect(host.invoke('acp_chat_take_back', { paneId: key })).rejects.toThrow(/\S/);
  });

  it('a refused far call reads as one sentence', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    vi.spyOn(f, 'request').mockResolvedValue({ status: 403, body: { error: 'no', code: 'DEVICE_NOT_ALLOWED' } } as never);
    await expect(acpChatApi(farHost(makePcLinkClient(NODE_MAC, f), f)).cancel('p1')).rejects.toThrow(/\S/);
  });
  it('the far host takes a pane by its key and says the far PC its own id, and gives the key back', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    const request = vi.spyOn(f, 'request').mockResolvedValue({ status: 200, body: { configOptions: [] } } as never);
    const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
    await host.invoke('acp_chat_state', { paneId: `dev:${NODE_MAC}:p1` });
    expect(request).toHaveBeenCalledWith(NODE_MAC, 'POST', '/pclink/call/acp_chat_state', { paneId: 'p1' });
    expect(placeKey(host.place, 'p1')).toBe(`dev:${NODE_MAC}:p1`);
    expect(placeKey(localHost.place, 'p1')).toBe('p1');
  });

  it('a command the far call table does not have is not sent: one plain sentence, and can() says no', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    const request = vi.spyOn(f, 'request');
    const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
    expect(host.can!('acp_chat_set_config')).toBe(true);
    expect(host.can!('handoff_open_file')).toBe(false);
    await expect(host.invoke('handoff_open_file', { paneId: 'p1' })).rejects.toThrow('Not on Mac mini yet.');
    expect(request).not.toHaveBeenCalled();
    expect(localHost.can).toBeUndefined();
  });
  it('the transcript opens as a snapshot, and an app frame for a far pane reaches the screen under the pane key', async () => {
    const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: [{ kind: 'user', id: 'u1', at: 1, text: 'hello' }] as never } });
    const host = farHost(makePcLinkClient(NODE_MAC, f), f, { name: 'Mac mini' });
    const snap = await host.invoke<{ available: boolean; items: { text: string }[] }>('session_chat_open', { paneId: `dev:${NODE_MAC}:p1`, surface: 's1' });
    expect(snap.available).toBe(true);
    expect(snap.items[0]!.text).toBe('hello');
    await host.invoke('session_chat_close', { paneId: `dev:${NODE_MAC}:p1`, surface: 's1' });
    const seen: unknown[] = [];
    const off = await host.listen('acp-chat-state', (p) => seen.push(p));
    f.emitEvent({ node: NODE_MAC, frame: `event: app
data: ${JSON.stringify({ event: 'acp-chat-state', payload: { paneId: 'p1', state: { phase: 'idle' } } })}

` });
    off();
    expect(seen).toEqual([{ paneId: `dev:${NODE_MAC}:p1`, state: { phase: 'idle' } }]);
  });
});
