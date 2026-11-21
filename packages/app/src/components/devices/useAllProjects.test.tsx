// @vitest-environment jsdom
// The merged Projects list: this PC's added folders and another device's projects come out of one list, each with its
// `location`; remote ones keep the `dev:<node>:<id>` key. Through the real device-group hook (only the command layer is fake).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { LOCAL, deviceLocation, locationBadge, parseLocation, sshLocation } from '../../lib/projectLocation';
import { readProjects, writeProjects, type SidebarProject } from '../../lib/sidebarProjects';
import { mergeProjects, useAllProjects, type ProjectEntry } from './useAllProjects';
import { useDeviceGroups } from './useDeviceGroups';

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
  window.localStorage.clear();
});

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};

const LOCAL_PROJECTS: SidebarProject[] = [{ path: '/work/alpha' }, { path: '/work/beta', name: 'Beta', location: sshLocation('h1', 'Build box') }];

describe('useAllProjects', () => {
  it('returns a local and a remote project in one list, each with its location', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } });
    let list: ProjectEntry[] = [];
    function Screen() {
      const groups = useDeviceGroups(fake);
      list = useAllProjects(LOCAL_PROJECTS, groups.groups);
      return null;
    }
    await act(async () => root.render(<Screen />));
    await flush();
    const local = list.filter((p) => p.location.kind !== 'device');
    expect(local.map((p) => [p.name, p.location])).toEqual([
      ['alpha', LOCAL],
      ['Beta', sshLocation('h1', 'Build box')],
    ]);
    const remote = list.filter((p) => p.location.kind === 'device');
    expect(remote.length).toBeGreaterThan(0);
    for (const p of remote) {
      expect(p.location).toEqual(deviceLocation(NODE_MAC, MAC_MINI.name));
      expect(p.key.startsWith(`dev:${NODE_MAC}:`)).toBe(true);
      expect(p.path).toBeNull();
      for (const r of p.rows) {
        expect(r.key.startsWith(`dev:${NODE_MAC}:`)).toBe(true);
        expect(r.location).toEqual(deviceLocation(NODE_MAC, MAC_MINI.name));
      }
    }
    expect(remote.flatMap((p) => p.rows.map((r) => r.key))).toContain(`dev:${NODE_MAC}:p1`);
  });

  it('mergeProjects with no devices is only the local list', () => {
    expect(mergeProjects(LOCAL_PROJECTS, []).map((p) => p.location.kind)).toEqual(['local', 'ssh']);
  });
});

describe('project location values', () => {
  it('reads anything unknown as local and keeps good values', () => {
    expect(parseLocation(undefined)).toEqual(LOCAL);
    expect(parseLocation({ kind: 'nope' })).toEqual(LOCAL);
    expect(parseLocation({ kind: 'device' })).toEqual(LOCAL);
    expect(parseLocation({ kind: 'device', node: 'n', name: 'PC' })).toEqual(deviceLocation('n', 'PC'));
    expect(parseLocation(JSON.parse(JSON.stringify(sshLocation('h', 'Box'))))).toEqual(sshLocation('h', 'Box'));
  });
  it('badge text: PC name, ssh (name), none for local', () => {
    expect(locationBadge(LOCAL)).toBeNull();
    expect(locationBadge(deviceLocation('n', 'Mac mini'))).toBe('Mac mini');
    expect(locationBadge(sshLocation('h', 'Build box'))).toBe('ssh (Build box)');
  });
  it('saved sidebar projects without a location still load (as local)', () => {
    window.localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: '/old' }]));
    expect(readProjects()[0]!.location).toBeUndefined();
    expect(mergeProjects(readProjects(), [])[0]!.location).toEqual(LOCAL);
    writeProjects([{ path: '/x', location: deviceLocation('n', 'PC') }]);
    expect(readProjects()[0]!.location).toEqual(deviceLocation('n', 'PC'));
  });
});
