// @vitest-environment jsdom
// WP4: a chat running on a paired PC is the NORMAL chat screen (the same conversation view and message box as a chat on this PC),
// not the phone's view in a phone-styled box. Through the real remote pane with a device fixture whose far chat has tool lines,
// page cards and a final answer.
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

const row = { paneId: 'p1', chat: true, title: 'Build the .dmg', agent: 'claude' } as const;

async function mount(device: ReturnType<typeof deviceOf>, fake: DevicesFake) {
  await act(async () => root.render(<RemotePaneView device={device} row={row} api={fake} />));
  await settle(10);
}
const deviceOf = (fake: DevicesFake) => fake.view.devices[0]!;

describe('a chat on another PC is the normal chat', () => {
  it('draws the normal conversation and message box, with no phone scope and no phone chat', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(deviceOf(fake), fake);
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-composer"]')).not.toBeNull();
    expect(host.querySelector('.ph')).toBeNull();
    expect(host.querySelector('[data-testid="phone-chat"]')).toBeNull();
    expect(host.querySelector('[data-testid="phone-composer"]')).toBeNull();
    // The old "Chat on <device>" title bar is gone: the chip in the sidebar names the PC.
    expect(host.textContent).not.toContain('Chat on Mac mini');
    expect(fake.requests.some((r) => r.path.startsWith('/pclink/sessions/p1/transcript'))).toBe(true);
  });

  it('a message goes to the far PC through its own message route', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: [] } });
    await mount(deviceOf(fake), fake);
    const box = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea')!;
    expect(box).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'hello there');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      box.form!.requestSubmit();
    });
    await settle(10);
    expect(fake.requests.some((r) => r.method === 'POST' && /^\/pclink\/sessions\/p1\/messages/.test(r.path))).toBe(true);
  });

  it('a PC that lets this one only watch says plainly what works in place of the message box', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(deviceOf(fake), fake);
    expect(host.querySelector('[data-testid="chat-composer"]')).toBeNull();
    expect(host.querySelector('[data-testid="remote-watch-only"]')!.textContent).toBe('You can watch here. Sending a message to Mac mini needs Answer there.');
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
  });
  it('has the normal pane header: the agent name, a small tag with the PC, the project; no Model-not-known line and no Open folder button in the corner', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await act(async () => root.render(<RemotePaneView device={deviceOf(fake)} row={{ ...row, cwd: '/Users/me/app' }} api={fake} />));
    await settle(10);
    const head = host.querySelector('[data-testid="remote-head"]')!;
    expect(head.querySelector('[data-testid="remote-name"]')!.textContent).toBe('Build the .dmg');
    expect(head.querySelector('[data-testid="remote-tag"]')!.textContent).toBe('Mac mini');
    expect(head.querySelector('[data-testid="open-remote-folder"]')!.textContent).toBe('app');
    // No Summary/Normal/Verbose switch in a chat on another PC.
    expect(head.querySelector('.dev-remote-slot')!.textContent).not.toContain('Summary');
    expect(host.textContent).not.toContain('Model not known yet');
    expect(host.textContent).not.toContain('Open folder on');
    expect(host.textContent).not.toContain('on Mac mini');
  });

  it('is drawn by the same chat view as a chat on this PC, with the device tag and no View switch', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(deviceOf(fake), fake);
    const chat = host.querySelector('[data-testid="session-chat"]')!;
    expect(chat).not.toBeNull();
    expect(chat.className).toContain('ck-chat');
    expect(chat.getAttribute('data-view')).toBe('normal');
    expect(host.querySelector('[data-testid="remote-tag"]')!.textContent).toBe('Mac mini');
    expect(host.querySelector('.ck-chat-mode-pill')).toBeNull();
    expect(host.textContent).not.toContain('View:');
  });
});
