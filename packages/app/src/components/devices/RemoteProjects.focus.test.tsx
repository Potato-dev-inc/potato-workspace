// @vitest-environment jsdom
// Connect > Devices > Open: that PC's projects in the sidebar unfold and the first one scrolls into view (and nothing else moves).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_MINI, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { focusDeviceGroup } from '../../lib/openDevice';
import { deviceLocation } from '../../lib/projectLocation';
import { RemoteProjects } from './RemoteProjects';
import type { ProjectEntry } from './useAllProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const row = (node: string, id: string) => ({ key: `dev:${node}:${id}`, node, paneId: id, agent: 'claude', title: `Chat ${id}`, cwd: '/work/app', status: 'idle', parent: null, project: 'app' }) as never;
const groups = [
  { device: MAC_MINI, rows: [row(MAC_MINI.node, 'p1')] },
  { device: { ...WORK_LAPTOP, state: 'online' as const }, rows: [row(WORK_LAPTOP.node, 'q1')] },
];
const entry = (node: string, name: string, name2: string, rows: unknown[]): ProjectEntry => ({
  key: `dev:${node}:${name2}`,
  name: name2,
  path: null,
  location: deviceLocation(node, name),
  rows: rows as ProjectEntry['rows'],
});
const entries = [entry(MAC_MINI.node, MAC_MINI.name, 'app', groups[0]!.rows), entry(WORK_LAPTOP.node, WORK_LAPTOP.name, 'app', groups[1]!.rows)];

describe('Open from Connect', () => {
  it('unfolds a folded PC project and scrolls to it, leaving the other PC folded', async () => {
    window.localStorage.setItem('pm.devices.foldedProjects', JSON.stringify([`dev:${MAC_MINI.node}:app`, `dev:${WORK_LAPTOP.node}:app`]));
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-remote-node') ?? '');
    };
    await act(async () => root.render(<RemoteProjects groups={groups} entries={entries} selectedKey={null} onOpen={() => undefined} launchEntries={[]} />));
    const head = (node: string) => host.querySelector(`[data-testid="device-project-dev:${node}:app"] .ck-proj-toggle`)!;
    expect(head(MAC_MINI.node).getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Chat p1');
    await act(async () => focusDeviceGroup(MAC_MINI.node));
    expect(head(MAC_MINI.node).getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Chat p1');
    expect(scrolled).toEqual([MAC_MINI.node]);
    // The other PC stays folded, and the fold is remembered.
    expect(head(WORK_LAPTOP.node).getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem('pm.devices.foldedProjects')!)).toEqual([`dev:${WORK_LAPTOP.node}:app`]);
  });

  it('an unfolded project is only scrolled to', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-remote-node') ?? '');
    };
    await act(async () => root.render(<RemoteProjects groups={groups} entries={entries} selectedKey={null} onOpen={() => undefined} launchEntries={[]} />));
    await act(async () => focusDeviceGroup(WORK_LAPTOP.node));
    expect(scrolled).toEqual([WORK_LAPTOP.node]);
  });
});
