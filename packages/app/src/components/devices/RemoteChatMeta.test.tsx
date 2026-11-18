// @vitest-environment jsdom
// A chat on another PC shows the branch, model and permission mode the far PC lists (Watch level, read-only), and the Full-needed
// reason up front. A far PC that is older and lists none of them draws nothing extra.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import { pcModeOf, pcNameOf } from '../../lib/runtime/pclink';
import { settle } from '../settings/test-utils';
import { RemotePaneView } from './RemotePaneView';
import { rowOf } from './useDeviceGroups';

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

const base = { paneId: 'p1', chat: true, title: 'Build the .dmg', agent: 'claude', cwd: 'app' } as const;

async function mount(level: 'watch' | 'answer' | 'full', row: Parameters<typeof RemotePaneView>[0]['row']) {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level }], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
  await act(async () => root.render(<RemotePaneView device={fake.view.devices[0]!} row={row} api={fake} />));
  await settle(10);
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('the far chat shows what the far PC says about it', () => {
  it('Full: branch beside the folder name, read-only agent, model and mode chips, and "Work lands on <branch>" under the box', async () => {
    await mount('full', { ...base, branch: 'feat/x', model: 'Sonnet 5.5', mode: 'asks' });
    expect(q('remote-branch')!.textContent).toBe('feat/x');
    expect(q('remote-chips')!.textContent).toContain('Sonnet 5.5');
    expect(q('remote-chips')!.textContent).toContain('Asks first');
    expect(q('remote-chips')!.querySelectorAll('[role="listbox"], [role="menu"]').length).toBe(0);
    expect(q('chat-composer')).not.toBeNull();
    expect(host.textContent).toContain('Work lands on feat/x');
    expect(q('remote-needs-full')).toBeNull();
  });

  it('Answer + a chat that acts without asking: the Full-needed reason is shown up front, with no message box', async () => {
    await mount('answer', { ...base, branch: 'main', model: 'Sonnet 5.5', mode: 'acts_without_asking' });
    expect(q('chat-composer')).toBeNull();
    expect(q('remote-needs-full')!.textContent).toContain('needs to allow Full');
    expect(q('remote-chips')!.textContent).toContain('Acts without asking');
  });

  it('Answer + a chat that asks: the box stays', async () => {
    await mount('answer', { ...base, mode: 'asks' });
    expect(q('chat-composer')).not.toBeNull();
    expect(q('remote-needs-full')).toBeNull();
  });

  it('Watch: the chips stay above the Watch-only line', async () => {
    await mount('watch', { ...base, model: 'Sonnet 5.5', mode: 'acts_without_asking' });
    expect(q('remote-watch-only')).not.toBeNull();
    expect(q('remote-needs-full')).toBeNull();
    expect(q('remote-chips')!.textContent).toContain('Sonnet 5.5');
  });

  it('an older far PC (none of the new fields): nothing extra, no error', async () => {
    await mount('full', { ...base });
    expect(q('remote-branch')).toBeNull();
    expect(q('remote-chips')).toBeNull();
    expect(host.textContent).not.toContain('Work lands on');
    expect(q('chat-composer')).not.toBeNull();
    await mount('answer', { ...base });
    expect(q('remote-needs-full')).toBeNull();
  });
});

describe('what a far PC lists is cleaned before it is shown', () => {
  it('names lose control characters and are cut to 80; a strange mode becomes unknown; missing stays missing', () => {
    expect(pcNameOf('feat/\u001b[31mx\n')).toBe('feat/[31mx');
    expect(pcNameOf('a'.repeat(200))!.length).toBe(80);
    // Bidi, zero-width and other format characters are dropped; the cut is by code points, so an emoji is never split.
    expect(pcNameOf(String.fromCodePoint(0x202e) + 'evil' + String.fromCodePoint(0x200b) + 'name' + String.fromCodePoint(0x200b))).toBe('evilname');
    expect(pcNameOf(String.fromCodePoint(0xfeff, 0x2066) + 'a' + String.fromCodePoint(0xe0041))).toBe('a');
    const emoji = String.fromCodePoint(0x1f600);
    expect(Array.from(pcNameOf(emoji.repeat(100))!).length).toBe(80);
    expect(pcNameOf(emoji.repeat(100))!.includes(String.fromCharCode(0xfffd))).toBe(false);
    expect(pcNameOf(null)).toBeUndefined();
    expect(pcNameOf(5)).toBeUndefined();
    expect(pcModeOf('asks')).toBe('asks');
    expect(pcModeOf('<b>x</b>')).toBe('unknown');
    expect(pcModeOf(undefined)).toBeUndefined();
    const row = rowOf('n', { id: 'p', agent: 'claude', title: 't', status: 'idle', project: 'a', folder: 'f', chat: true, branch: 'b'.repeat(300), model: null, mode: 'weird' as never });
    expect(row.branch!.length).toBe(80);
    expect(row.model).toBeUndefined();
    expect(row.mode).toBe('unknown');
    expect('branch' in rowOf('n', { id: 'p', agent: 'a', title: 't', status: 'idle', project: 'a', folder: 'f', chat: true })).toBe(false);
  });
});
