import { describe, expect, it } from 'vitest';
import { MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../dev/devices-fixtures';
import { activityLine, cannotPickWhy, chipText, clockText, deviceNotices, devicesEnabled, isRemoteId, lastSeenText, parseRemoteId, remoteId, requestError, runtimesOf, sortActivity, stateSentence, stateWord, type DevicesView } from './devices';

const view = (devices = [MAC_MINI, WORK_LAPTOP], enabled = true): DevicesView => ({
  enabled,
  name: 'Desk-PC',
  route_pref: 'auto',
  own_route_ready: false,
  hosting: null,
  pending: null,
  joining: null,
  message: null,
  locked_until: null,
  tampered: false,
  devices,
});

describe('devices rules', () => {
  it('is on only when the Labs flag is exactly true', () => {
    expect(devicesEnabled({ devices_enabled: true })).toBe(true);
    expect(devicesEnabled({ devices_enabled: false })).toBe(false);
    expect(devicesEnabled(null)).toBe(false);
  });

  it('namespaces a far pane so nothing local can look like it', () => {
    const id = remoteId(NODE_MAC, 'p1');
    expect(id).toBe(`dev:${NODE_MAC}:p1`);
    expect(parseRemoteId(id)).toEqual({ node: NODE_MAC, paneId: 'p1' });
    expect(isRemoteId(id)).toBe(true);
    expect(isRemoteId('p1')).toBe(false);
    expect(isRemoteId('dev:short:p1')).toBe(false);
    expect(isRemoteId(null)).toBe(false);
    // A pane id with colons stays whole.
    expect(parseRemoteId(remoteId(NODE_MAC, 'a:b'))).toEqual({ node: NODE_MAC, paneId: 'a:b' });
  });

  it('says the state in plain words, one word for the group header', () => {
    expect(stateWord(MAC_MINI)).toBeNull();
    expect(stateWord(WORK_LAPTOP)).toBe('offline');
    expect(stateWord({ state: 'not_allowed' })).toBe('not allowed');
    expect(stateSentence(MAC_MINI)).toBe('Online · same network');
    expect(stateSentence({ ...MAC_MINI, path: 'relay' })).toBe('Online · through relay (slower)');
    expect(stateSentence({ ...WORK_LAPTOP, last_seen: null })).toBe('Not seen yet');
    expect(stateSentence({ ...MAC_MINI, state: 'not_allowed' })).toContain('does not let this PC run agents');
    expect(lastSeenText({ last_seen: null })).toBe('Not seen yet');
    expect(lastSeenText({ last_seen: 1_700_000_000 })).toBe(`Last seen ${clockText(1_700_000_000)}`);
  });

  it('shows the route chip only for a live link', () => {
    expect(chipText({ state: 'online', path: 'direct' })).toBe('Direct');
    expect(chipText({ state: 'online', path: 'relay' })).toBe('Relay');
    expect(chipText({ state: 'online', path: 'own' })).toBe('Your link');
    expect(chipText({ state: 'offline', path: null })).toBeNull();
    expect(chipText({ state: 'online', path: null })).toBeNull();
  });

  it('lists This PC first, then Linux places, then each device; only an online one can be picked', () => {
    const list = runtimesOf(view(), ['Ubuntu']);
    expect(list.map((r) => r.label)).toEqual(['This PC', 'Ubuntu', 'Mac mini', 'Work laptop']);
    const mac = list[2]!;
    const laptop = list[3]!;
    expect(mac.kind === 'device' && mac.pickable).toBe(true);
    expect(laptop.kind === 'device' && laptop.pickable).toBe(false);
    expect(laptop.kind === 'device' && laptop.why).toBe('offline');
    expect(cannotPickWhy({ ...MAC_MINI, state: 'not_allowed' })).toBe('not allowed');
  });

  it('lists only This PC while the switch is off', () => {
    expect(runtimesOf(view([MAC_MINI], false)).map((r) => r.label)).toEqual(['This PC']);
    expect(runtimesOf(null).map((r) => r.label)).toEqual(['This PC']);
  });

  it('turns a refused call into the plain sentence', () => {
    expect(requestError('Mac mini', { status: 403, body: { error: 'not_allowed' } })).toBe('Mac mini does not let this PC run agents. Turn it on there: Settings › Devices.');
    expect(requestError('Mac mini', { status: 400, body: { hint: 'Pick a folder.' } })).toBe('Pick a folder.');
    expect(requestError('Mac mini', { status: 500, body: {} })).toBe('HTTP 500');
    expect(requestError('Mac mini', new Error('That device is offline.'))).toBe('That device is offline.');
  });
});

describe('device states and notices', () => {
  const at = (h: number, m: number) => Math.floor(new Date(2026, 10, 15, h, m).getTime() / 1000);

  it('has one plain word and one sentence for every state', () => {
    expect(stateWord({ ...MAC_MINI, state: 'asleep' })).toBe('asleep');
    expect(stateWord({ ...MAC_MINI, state: 'closed' })).toBe('closed');
    expect(stateWord({ ...MAC_MINI, needs_person: [{ pane: 'p1', what: 'a password box' }] })).toBe('needs you');
    expect(stateWord({ ...MAC_MINI, too_old: true })).toBe('older version');
    expect(stateWord(MAC_MINI)).toBeNull();
    expect(stateSentence({ ...MAC_MINI, state: 'asleep' })).toBe('Asleep or off.');
    expect(stateSentence({ ...MAC_MINI, state: 'closed' })).toBe('Potato Workspace is closed on Mac mini.');
    expect(stateSentence({ ...MAC_MINI, too_old: true })).toBe('Mac mini runs an older Potato Workspace. Update it to connect.');
    expect(stateSentence({ ...MAC_MINI, path: 'own' })).toBe('Online · through your own link');
    expect(cannotPickWhy({ ...MAC_MINI, state: 'asleep' })).toBe('asleep');
    expect(cannotPickWhy({ ...MAC_MINI, state: 'closed' })).toBe('closed');
    expect(cannotPickWhy({ ...MAC_MINI, too_old: true })).toBe('older version');
  });

  it('lists the notices in order: state, signed out, needs a person', () => {
    const d = { ...MAC_MINI, signed_out: ['claude', 'codex'], needs_person: [{ pane: 'p2', what: 'a password box is open there' }] };
    expect(deviceNotices(MAC_MINI)).toEqual([]);
    const all = deviceNotices(d);
    expect(all.map((n) => n.kind)).toEqual(['signedOut', 'signedOut', 'needsPerson']);
    expect(all[0]!.text).toBe('Claude is signed out on Mac mini.');
    expect(all[0]!.hint).toBe('Sign in on Mac mini. Sign-ins stay on their own device.');
    expect(all[2]!.text).toBe('Needs a person at Mac mini: a password box is open there');
    // Only the agents of the pane being looked at; none for the sidebar.
    expect(deviceNotices(d, ['codex']).map((n) => n.text)).toEqual(['Codex is signed out on Mac mini.', 'Needs a person at Mac mini: a password box is open there']);
    expect(deviceNotices(d, []).map((n) => n.kind)).toEqual(['needsPerson']);
  });

  it('offers Try again for offline and asleep only, and says nothing about sign-ins of a device that is down', () => {
    const t = (state: 'offline' | 'asleep' | 'closed' | 'not_allowed') => deviceNotices({ ...MAC_MINI, state, last_seen: at(14, 2), signed_out: ['claude'] });
    expect(t('offline').map((n) => [n.text, n.retry])).toEqual([['Offline. Last seen 14:02.', true]]);
    expect(t('asleep').map((n) => [n.text, n.retry])).toEqual([['Asleep or off.', true]]);
    expect(t('closed').map((n) => [n.text, n.retry])).toEqual([['Potato Workspace is closed on Mac mini.', false]]);
    expect(t('not_allowed')[0]!.text).toBe('Mac mini does not let this PC run agents. Turn it on there: Settings › Devices.');
    expect(deviceNotices({ ...MAC_MINI, too_old: true })[0]!.text).toContain('older Potato Workspace');
  });

  it('keeps text from a device short and free of control characters', () => {
    const d = { ...MAC_MINI, needs_person: [{ pane: 'p', what: 'x\u0007\nboo'.padEnd(400, 'y') }] };
    const text = deviceNotices(d)[0]!.text;
    expect(text).not.toMatch(/[\u0000-\u001f]/);
    expect(text.length).toBeLessThan(260);
  });

  it('writes an activity line for each side and drops what is not ours', () => {
    expect(activityLine({ at: at(14, 2), node: NODE_MAC, name: 'Desk-PC', dir: 'in', kind: 'started' })).toBe('14:02 Desk-PC started an agent');
    expect(activityLine({ at: at(14, 2), node: NODE_MAC, name: 'Mac mini', dir: 'out', kind: 'started' })).toBe('14:02 Started an agent on Mac mini');
    const list = sortActivity([
      { at: 1, node: 'a', name: 'A', dir: 'in', kind: 'typed' },
      { at: 3, node: 'a', name: 'A', dir: 'out', kind: 'refused' },
      { at: 2, node: 'a', name: 'A', dir: 'sideways', kind: 'typed' },
      { at: 4, node: 'a', name: 'A', dir: 'in', kind: 'delete-everything' },
      null,
    ]);
    expect(list.map((e) => e.at)).toEqual([3, 1]);
    expect(sortActivity('nope')).toEqual([]);
  });
});
