// The far PC's answers as the sources of the New agent page: pseudo folders, agents, and what Start does on the far side.
import { describe, expect, it, vi } from 'vitest';
import { PcLinkError, type PcLinkClient, type PcNewAgentOptions } from './pclink';
import { buildRemoteNewAgent, remotePathOf, remoteProjectId, remoteRecents } from './remoteNewAgent';

const OPTIONS: PcNewAgentOptions = {
  agents: [
    { id: 'claude', label: 'Claude', chat: true, terminal: true },
    { id: 'plain', label: 'Plain', chat: false, terminal: true },
  ],
  projects: [
    { id: 'p1', name: 'app', state: 'repo' },
    { id: 'p2', name: 'gone', state: 'missing' },
    { id: 'p3', name: 'notes', state: 'something-new' },
  ],
  terminals: true,
};

function fakeClient(extra: Partial<PcLinkClient> = {}): PcLinkClient {
  return {
    node: 'n',
    startAgent: vi.fn(async () => ({ pane_id: 'n1' })),
    sendMessage: vi.fn(async () => ({}) as never),
    setConfig: vi.fn(async () => ({}) as never),
    modelOptions: vi.fn(async () => ({ models: ['a', 'b'], live: { id: 'mdl', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] } })),
    warm: vi.fn(async () => undefined),
    ...extra,
  } as unknown as PcLinkClient;
}

describe('remote New agent sources', () => {
  it('maps a far project id to a pseudo folder and back, skipping missing ones and unknown states', () => {
    expect(remoteProjectId(remotePathOf('p1'))).toBe('p1');
    expect(remoteProjectId('/Users/me/app')).toBeNull();
    expect(remoteRecents(OPTIONS).map((p) => [p.path, p.state])).toEqual([
      ['remote:p1', 'repo'],
      ['remote:p3', 'folder'],
    ]);
  });

  it('lists the far agents as chat or terminal lanes, never the local ones', async () => {
    const r = buildRemoteNewAgent(OPTIONS, { client: fakeClient(), node: 'n', deviceName: 'Mac mini', canControl: () => true, onStarted: () => {} });
    expect(r.agents.map((a) => a.id)).toEqual(['claude', 'plain']);
    expect(await r.api.lanes()).toEqual({ labsEnabled: true, agents: [{ id: 'claude', lane: 'acp', disabled: false }, { id: 'plain', lane: 'terminal', disabled: false }] });
    expect(await r.api.pickFolder()).toBeNull();
    expect(await r.api.accounts()).toEqual([]);
  });

  it('Start starts the chat through the PC link, sets the model with the far option id, sends the first message, then opens it', async () => {
    const client = fakeClient();
    const onStarted = vi.fn();
    const r = buildRemoteNewAgent(OPTIONS, { client, node: 'n', deviceName: 'Mac mini', canControl: () => true, onStarted });
    await r.modelApi.get('claude');
    const pane = await r.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: true, runAs: 'chat', prompt: 'hi', model: 'b' });
    expect(pane).toBe('n1');
    expect(client.startAgent).toHaveBeenCalledWith({ agent: 'claude', project: 'p1', lane: 'chat' });
    expect(client.setConfig).toHaveBeenCalledWith('n1', 'mdl', 'b');
    expect(client.sendMessage).toHaveBeenCalledWith('n1', 'hi');
    expect(onStarted).toHaveBeenCalledWith('n1', true);
  });

  it('keeps the person in the page when the first message does not go, and sends it to the same chat the next time', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({});
    const client = fakeClient({ sendMessage: send as never });
    const onStarted = vi.fn();
    const r = buildRemoteNewAgent(OPTIONS, { client, node: 'n', deviceName: 'Mac', canControl: () => true, onStarted });
    const req = { agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat' as const, prompt: 'hi' };
    await expect(r.onStart(req)).rejects.toThrow('Mac started the agent, but your message did not go.');
    expect(onStarted).not.toHaveBeenCalled();
    await r.onStart(req);
    expect(client.startAgent).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onStarted).toHaveBeenCalledWith('n1', true);
  });

  it('refuses without control with the device named, and answers a dead link with the device did not answer', async () => {
    const client = fakeClient();
    const watch = buildRemoteNewAgent(OPTIONS, { client, node: 'n', deviceName: 'REN-LAPTOP', canControl: () => false, onStarted: () => {} });
    await expect(watch.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi' })).rejects.toThrow('REN-LAPTOP lets this PC watch only. Change it on REN-LAPTOP.');
    expect(client.startAgent).not.toHaveBeenCalled();
    const dead = buildRemoteNewAgent(OPTIONS, { client: fakeClient({ startAgent: vi.fn(async () => { throw new Error('That device is offline.'); }) as never }), node: 'n', deviceName: 'REN-LAPTOP', canControl: () => true, onStarted: () => {} });
    await expect(dead.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi' })).rejects.toThrow('REN-LAPTOP didn’t answer.'.replace('’', "'"));
  });

  it('a 403 from the far PC reads as "lets this PC watch only", whatever this side believed', async () => {
    const refused = vi.fn(async () => { throw new PcLinkError(403, { error: 'not_allowed', code: 'DEVICE_NOT_ALLOWED' }, 'POST', '/pclink/agents/start'); });
    const r = buildRemoteNewAgent(OPTIONS, { client: fakeClient({ startAgent: refused as never }), node: 'n', deviceName: 'REN-LAPTOP', canControl: () => true, onStarted: () => {} });
    await expect(r.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi' })).rejects.toThrow('REN-LAPTOP lets this PC watch only.');
  });

  it('never guesses the model setting name: without a loaded far list the model is not set and the person is told', async () => {
    const client = fakeClient();
    const notify = vi.fn();
    const r = buildRemoteNewAgent(OPTIONS, { client, node: 'n', deviceName: 'Mac', canControl: () => true, onStarted: () => {}, notify });
    await r.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi', model: 'b' });
    expect(client.setConfig).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('b was not set. The chat uses its default model.');
  });

  it('warms the far chat program for an agent and a far folder only', () => {
    const warm = vi.fn(async () => undefined);
    const r = buildRemoteNewAgent(OPTIONS, { client: fakeClient({ warm: warm as never }), node: 'n', deviceName: 'Mac', canControl: () => true, onStarted: () => {} });
    r.warm('claude', 'remote:p1');
    r.warm('claude', '/local/path');
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenCalledWith({ agent: 'claude', project: 'p1' });
  });

  it('says what the far PC said when it refused (400), not that it did not answer', async () => {
    const refused = vi.fn(async () => { throw new PcLinkError(400, { error: 'project is not known' }, 'POST', '/pclink/agents/start'); });
    const r = buildRemoteNewAgent(OPTIONS, { client: fakeClient({ startAgent: refused as never }), node: 'n', deviceName: 'REN-LAPTOP', canControl: () => true, onStarted: () => {} });
    await expect(r.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi' })).rejects.toThrow('REN-LAPTOP could not start it: project is not known');
  });

  it('leaves the model unset (and says so) when the far list has no setting name, instead of using a guessed one', async () => {
    const client = fakeClient({ modelOptions: vi.fn(async () => ({ models: ['a', 'b'] })) as never });
    const notify = vi.fn();
    const r = buildRemoteNewAgent(OPTIONS, { client, node: 'n', deviceName: 'Mac', canControl: () => true, onStarted: () => {}, notify });
    await r.modelApi.get('claude');
    await r.onStart({ agentId: 'claude', folder: 'remote:p1', isolated: false, runAs: 'chat', prompt: 'hi', model: 'b' });
    expect(client.setConfig).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('b was not set. The chat uses its default model.');
  });
});
