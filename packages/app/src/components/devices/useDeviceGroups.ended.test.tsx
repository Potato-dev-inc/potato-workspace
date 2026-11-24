// @vitest-environment jsdom
// A far chat that was listed, whose PC went away and came back without it (the app there restarted), is kept as ended until it is forgotten.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { useDeviceGroups, type DeviceGroups } from './useDeviceGroups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};

describe('a far chat that ended while its PC was off', () => {
  it('stays in the group as ended (stopped, not working); forget drops it', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    let groups: DeviceGroups | null = null;
    function Screen() {
      groups = useDeviceGroups(fake);
      return null;
    }
    await act(async () => root.render(<Screen />));
    await flush();
    const before = groups!.groups[0]!.rows;
    expect(before.length).toBeGreaterThan(1);
    const gone = before[0]!;
    // The PC goes away; it comes back with one chat fewer.
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', path: null }));
    await flush();
    fake.panes[NODE_MAC] = fake.panes[NODE_MAC]!.filter((p) => p.id !== gone.paneId);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'online', path: 'direct' }));
    await flush();
    const after = groups!.groups[0]!.rows;
    const kept = after.find((r) => r.key === gone.key);
    expect(kept?.ended).toBe(true);
    expect(kept?.status).toBe('exited');
    expect(after.filter((r) => !r.ended)).toHaveLength(before.length - 1);
    await act(async () => groups!.forget(gone.key));
    expect(groups!.groups[0]!.rows.find((r) => r.key === gone.key)).toBeUndefined();
  });

  it('a chat closed while the PC stayed on is simply gone', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    let groups: DeviceGroups | null = null;
    function Screen() {
      groups = useDeviceGroups(fake);
      return null;
    }
    await act(async () => root.render(<Screen />));
    await flush();
    const before = groups!.groups[0]!.rows;
    fake.panes[NODE_MAC] = fake.panes[NODE_MAC]!.slice(1);
    await act(async () => groups!.refresh());
    await flush(30);
    expect(groups!.groups[0]!.rows.some((r) => r.ended)).toBe(false);
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('a far PC that stops answering while its chat is Working', () => {
  it('shows the PC as not answering after 12 s of silence and comes back by itself on the next reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
      let groups: DeviceGroups | null = null;
      function Screen() {
        groups = useDeviceGroups(fake);
        return null;
      }
      await act(async () => root.render(<Screen />));
      await flush();
      expect(groups!.groups[0]!.rows.some((r) => r.status === 'running')).toBe(true);
      expect(groups!.groups[0]!.device.quiet).toBeUndefined();
      const answer = fake.request;
      fake.request = async () => {
        throw new Error('no answer');
      };
      await act(async () => void (await vi.advanceTimersByTimeAsync(8_000)));
      expect(groups!.groups[0]!.device.quiet).toBeUndefined();
      await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
      expect(groups!.groups[0]!.device.quiet).toBe(true);
      expect(groups!.groups[0]!.device.state).toBe('offline');
      fake.request = answer;
      await act(async () => void (await vi.advanceTimersByTimeAsync(45_000)));
      expect(groups!.groups[0]!.device.quiet).toBeUndefined();
      expect(groups!.groups[0]!.device.state).toBe('online');
    } finally {
      vi.useRealTimers();
    }
  });
});
