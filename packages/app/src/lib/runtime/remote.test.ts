import { describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { deviceTransport, makeRemoteClient, parseFrame, subscribeRemote } from './remote';

const fake = () => new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });

describe('remote bridge client', () => {
  it('runs the same typed calls through the device request', async () => {
    const f = fake();
    const client = makeRemoteClient(NODE_MAC, f);
    const panes = await client.listPanes();
    expect(panes.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(f.requests[0]).toMatchObject({ node: NODE_MAC, method: 'GET', path: '/panes' });
    const spawned = await client.spawnPane({ agent_type: 'claude', cwd: '/x' });
    expect(spawned.pane_id).toBe('n3');
    expect(f.requests.at(-1)).toMatchObject({ method: 'POST', path: '/panes' });
  });

  it('a refused call throws an error that names the status and the far answer', async () => {
    const f = fake();
    f.setDevice(NODE_MAC, { state: 'not_allowed' });
    const client = makeRemoteClient(NODE_MAC, f);
    await expect(client.listPanes()).rejects.toThrow(/-> 403: .*not_allowed/);
  });

  it('an unreachable device is an error, not an empty list', async () => {
    const f = fake();
    f.setDevice(NODE_MAC, { state: 'offline' });
    await expect(makeRemoteClient(NODE_MAC, f).listPanes()).rejects.toThrow('That device is offline.');
  });

  it('the transport hands the body text of the answer', async () => {
    const f = fake();
    const res = await deviceTransport(NODE_MAC, f)('GET', '/panes');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toHaveLength(2);
  });

  it('reads one bridge frame into its typed event, and ignores noise', () => {
    expect(parseFrame('event: pane-status\ndata: {"pane_id":"p1","status":"idle"}\n\n')).toEqual({ type: 'pane-status', pane_id: 'p1', status: 'idle' });
    expect(parseFrame(': keep-alive\n\n')).toBeNull();
    expect(parseFrame('event: pane-status\ndata: {broken\n\n')).toBeNull();
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
    f.emitEvent({ node: NODE_MAC, frame: 'event: pane-status\ndata: {"pane_id":"p1","status":"idle"}\n\n' });
    f.emitEvent({ node: 'other', frame: 'event: pane-status\ndata: {"pane_id":"p9","status":"idle"}\n\n' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA();
    expect(unsub).not.toHaveBeenCalled();
    stopB();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
