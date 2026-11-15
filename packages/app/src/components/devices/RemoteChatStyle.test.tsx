// @vitest-environment jsdom
// 1.1.3 bug: a chat running on a paired PC drew unstyled (giant black triangles, a bare box, the result bar run together). The remote
// chat is the phone's view, whose styles all live under `.ph`; the desktop pane did not have that class. Through the real remote pane
// (inside `.cockpit`, like CockpitApp) with a device fixture whose far chat has a permission line, page cards and a final answer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import { settle } from '../settings/test-utils';
import { RemotePaneView } from './RemotePaneView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a chat on another PC is styled like a chat', () => {
  it('sits inside the phone scope, and the box, the result bar and every icon have a class and a size', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    const device = fake.view.devices[0]!;
    await act(async () => root.render(<RemotePaneView device={device} row={{ paneId: 'p1', chat: true, title: 'Build the .dmg', agent: 'claude' }} api={fake} />));
    await settle(10);
    const scope = host.querySelector('[data-testid="remote-chat-scope"]')!;
    expect(scope.classList.contains('ph')).toBe(true);
    const chat = host.querySelector('[data-testid="phone-chat"]')!;
    expect(chat.closest('.ph')).toBe(scope);
    expect(chat.className).toBe('ph-chat');
    const composer = host.querySelector('[data-testid="phone-composer"]');
    expect(composer).not.toBeNull();
    expect(composer!.className).toMatch(/ph-/);
    expect(composer!.querySelector('textarea')?.closest('.ph-comp-box')).not.toBeNull();
    await settle(10);
    const bar = host.querySelector('[data-testid="phone-result-card"]');
    expect(bar).not.toBeNull();
    expect(bar!.className).toBe('ph-result');
    expect(bar!.querySelector('.ph-result-head')).not.toBeNull();
    expect(bar!.querySelector('.ph-result-actions')).not.toBeNull();
    const svgs = Array.from(scope.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThan(3);
    const unsized = svgs.filter((svg) => {
      const w = Number(svg.getAttribute('width'));
      const h = Number(svg.getAttribute('height'));
      return !(w >= 8 && w <= 48 && h >= 8 && h <= 48);
    });
    expect(unsized.map((svg) => svg.outerHTML.slice(0, 90))).toEqual([]);
  });
});
