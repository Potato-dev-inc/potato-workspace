import { describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { PcLinkError, atLeast, makePcLinkClient } from './pclink';
import { makeRemoteClient, parseFrame, subscribeRemote } from './remote';

const fake = (level?: 'watch' | 'answer' | 'full') => {
  const f = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
  if (level) f.farLevels[NODE_MAC] = level;
  return f;
};

describe('PC link client', () => {
  it('lists the far PC sessions through its own /pclink/ route, with parent links and the chat flag', async () => {
    const f = fake();
    const client = makeRemoteClient(NODE_MAC, f);
    const sessions = await client.sessions();
    expect(sessions.map((p) => [p.id, p.chat])).toEqual([
      ['p1', true],
      ['p2', false],
    ]);
    expect(f.requests[0]).toMatchObject({ node: NODE_MAC, method: 'GET', path: '/pclink/sessions' });
  });

  it('every call goes to a /pclink/ path and none to a phone or bridge path', async () => {
    const f = fake('full');
    const c = makePcLinkClient(NODE_MAC, f);
    await c.me();
    await c.sessions();
    await c.transcript('p1', 3);
    await c.transcriptEarlier('p1', 'i9', 20);
    await c.screen('p2');
    await c.agentOptions();
    await c.messages('p1');
    await c.sendMessage('p1', 'hi');
    await c.interrupt('p1');
    await c.input('p2', 'ls');
    await c.modelOptions('claude');
    await c.warm({ agent: 'claude', project: 'proj-app' });
    const started = await c.startAgent({ agent: 'claude', project: 'proj-app', lane: 'chat' });
    await c.setConfig(started.pane_id, 'model', 'x');
    await c.close(started.pane_id);
    await c.moveWork({ project: 'proj-app', branch: 'potato/move-1', bundle_b64: 'AAAA' });
    await expect(c.requestFull()).rejects.toThrow(/-> 409/);
    expect(f.requests.length).toBeGreaterThan(15);
    for (const r of f.requests) expect(r.path.startsWith('/pclink/'), r.path).toBe(true);
  });

  it('a refused call throws an error that names the status and the far answer', async () => {
    const f = fake();
    f.setDevice(NODE_MAC, { state: 'not_allowed' });
    const client = makeRemoteClient(NODE_MAC, f);
    await expect(client.sessions()).rejects.toThrow(/-> 403: .*not_allowed/);
  });

  it('the level decides on the far side: Watch cannot send, Answer cannot start, Full can', async () => {
    const f = fake('watch');
    const c = makeRemoteClient(NODE_MAC, f);
    await expect(c.sendMessage('p1', 'x')).rejects.toBeInstanceOf(PcLinkError);
    f.farLevels[NODE_MAC] = 'answer';
    await expect(c.sendMessage('p1', 'x')).resolves.toMatchObject({ text: 'x' });
    await expect(c.startAgent({ agent: 'claude', project: 'p', lane: 'chat' })).rejects.toThrow(/-> 403/);
    f.farLevels[NODE_MAC] = 'full';
    await expect(c.startAgent({ agent: 'claude', project: 'p', lane: 'chat' })).resolves.toHaveProperty('pane_id');
  });

  it('an unreachable device is an error, not an empty list', async () => {
    const f = fake();
    f.setDevice(NODE_MAC, { state: 'offline' });
    await expect(makeRemoteClient(NODE_MAC, f).sessions()).rejects.toThrow('That device is offline.');
  });

  it('the far PC says what this PC may do, and "ask" is a real request that grants nothing', async () => {
    const f = fake('answer');
    const c = makeRemoteClient(NODE_MAC, f);
    expect(await c.me()).toMatchObject({ level: 'answer', asked: false });
    expect(await c.requestFull()).toMatchObject({ asked: true });
    expect(await c.me()).toMatchObject({ level: 'answer', asked: true });
    await expect(c.startAgent({ agent: 'claude', project: 'p', lane: 'chat' })).rejects.toThrow(/-> 403/);
    f.grantFull(NODE_MAC);
    expect(await c.me()).toMatchObject({ level: 'full', asked: false });
  });

  it('atLeast orders the three levels and an unknown level reaches nothing', () => {
    expect([atLeast('watch', 'watch'), atLeast('watch', 'answer'), atLeast('answer', 'answer'), atLeast('answer', 'full'), atLeast('full', 'full')]).toEqual([true, false, true, false, true]);
    expect([atLeast(null, 'watch'), atLeast(undefined, 'watch')]).toEqual([false, false]);
  });

  it('reads one PC link frame into its event, and ignores noise and the phone\'s frames', () => {
    expect(parseFrame('event: session-status\ndata: {"id":"p1","status":"idle"}\n\n')).toEqual({ type: 'session-status', id: 'p1', status: 'idle' });
    expect(parseFrame('event: sessions\ndata: {}\n\n')).toEqual({ type: 'sessions' });
    expect(parseFrame('event: outbox\ndata: {"id":"p1"}\n\n')).toEqual({ type: 'outbox', id: 'p1' });
    expect(parseFrame(': keep-alive\n\n')).toBeNull();
    expect(parseFrame('event: session-status\ndata: {broken\n\n')).toBeNull();
    // The phone's own event names are not the PC link's.
    expect(parseFrame('event: pane-status\ndata: {"pane_id":"p1","status":"idle"}\n\n')).toBeNull();
    expect(parseFrame('event: panes\ndata: []\n\n')).toBeNull();
  });

  it('subscribes once per device however many listen, hands only that device events, and unsubscribes with the last', async () => {
    const f = fake();
    const sub = vi.spyOn(f, 'subscribe');
    const unsub = vi.spyOn(f, 'unsubscribe');
    const a = vi.fn();
    const b = vi.fn();
    const stopA = await subscribeRemote(NODE_MAC, f, a);
    const stopB = await subscribeRemote(NODE_MAC, f, b);
    expect(sub).toHaveBeenCalledTimes(1);
    f.emitEvent({ node: NODE_MAC, frame: 'event: session-status\ndata: {"id":"p1","status":"idle"}\n\n' });
    f.emitEvent({ node: 'other', frame: 'event: session-status\ndata: {"id":"p9","status":"idle"}\n\n' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA();
    expect(unsub).not.toHaveBeenCalled();
    stopB();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
