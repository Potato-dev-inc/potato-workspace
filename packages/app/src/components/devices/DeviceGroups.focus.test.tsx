// @vitest-environment jsdom
// Connect > Devices > Open: the sidebar section of that PC unfolds and scrolls into view (and nothing else moves).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_MINI, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { focusDeviceGroup } from '../../lib/openDevice';
import { DeviceGroups } from './DeviceGroups';

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

const row = (node: string, id: string) => ({ key: `dev:${node}:${id}`, node, paneId: id, agent: 'claude', title: `Chat ${id}`, cwd: '/work/app', status: 'idle', parent: null }) as never;
const groups = [
  { device: MAC_MINI, rows: [row(MAC_MINI.node, 'p1')] },
  { device: { ...WORK_LAPTOP, state: 'online' as const }, rows: [row(WORK_LAPTOP.node, 'q1')] },
];

describe('Open from Connect', () => {
  it('unfolds a folded PC section and scrolls to it, leaving the other section alone', async () => {
    window.localStorage.setItem('pm.devices.folded', JSON.stringify([MAC_MINI.node, WORK_LAPTOP.node]));
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-testid') ?? '');
    };
    await act(async () => root.render(<DeviceGroups groups={groups} selectedKey={null} onOpen={() => undefined} />));
    const head = (node: string) => host.querySelector(`[data-testid="device-group-${node}"] .dev-group-head`)!;
    expect(head(MAC_MINI.node).getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Chat p1');
    await act(async () => focusDeviceGroup(MAC_MINI.node));
    expect(head(MAC_MINI.node).getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('Chat p1');
    expect(scrolled).toEqual([`device-group-${MAC_MINI.node}`]);
    // The other PC stays folded, and the fold is remembered.
    expect(head(WORK_LAPTOP.node).getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(window.localStorage.getItem('pm.devices.folded')!)).toEqual([WORK_LAPTOP.node]);
  });

  it('an unfolded section is only scrolled to', async () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-testid') ?? '');
    };
    await act(async () => root.render(<DeviceGroups groups={groups} selectedKey={null} onOpen={() => undefined} />));
    await act(async () => focusDeviceGroup(WORK_LAPTOP.node));
    expect(scrolled).toEqual([`device-group-${WORK_LAPTOP.node}`]);
  });
});
