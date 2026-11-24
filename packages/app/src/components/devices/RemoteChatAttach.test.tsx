// @vitest-environment jsdom
// P4.3: a picture pasted into the box of a chat on another PC reaches that PC (the normal composer in the far host: its own call row
// `attachment_save_pasted`, the bytes as text, the chat's key turned into the far PC's own id), shows as the usual chip, and goes with the message.
// A file picked on this PC is read here and sent the same way. Nothing is saved on this PC's disk (no local `attachment_save_pasted`).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, type RemotePane } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import { prepareAttachments } from '../../lib/attachFiles';
import { farHost } from '../../lib/host/far';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { settle } from '../settings/test-utils';
import { FarPane } from './FarPane';
import { rowOf } from './useDeviceGroups';

const localInvokes: { cmd: string; args: unknown }[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    localInvokes.push({ cmd, args });
    if (cmd === 'attachment_read_local') return { name: 'notes.pdf', mime: 'application/pdf', dataBase64: 'JVBERg==' };
    return null;
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }) }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => <div data-testid="term" /> }));

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
  localInvokes.length = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const PANE: RemotePane = { id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp' };

function fakeCockpit(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [{ type: 'claude', label: 'Claude' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    interrupt: vi.fn(async () => {}),
    closePane: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    prompts: {},
    activities: {},
    previews: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

async function mount(level: 'answer' | 'full') {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level }], panes: { [NODE_MAC]: [PANE] }, chats: { p1: phoneRenderReply(Date.now()).items } });
  fake.farLevels[NODE_MAC] = level;
  const row = rowOf(NODE_MAC, { id: PANE.id, agent: PANE.agent_type, title: PANE.title, status: PANE.status, project: 'p', folder: 'app', chat: true });
  await act(async () => root.render(<FarPane device={fake.view.devices[0]!} row={row} rows={[row]} c={fakeCockpit()} api={fake} openRow={() => {}} />));
  await settle(14);
  return fake;
}
const field = () => host.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea')!;
const chips = () => [...host.querySelectorAll('[data-testid="attachment-chip"]')].map((el) => el.getAttribute('data-name'));

function pasteImage(name = 'shot.png') {
  const file = new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: [file], items: [], types: [], getData: () => '' } });
  act(() => {
    field().dispatchEvent(event);
  });
}

describe('attach to a chat on another PC', () => {
  it('a pasted picture is sent to that PC under its own chat id, shows as the usual chip, and goes with the message', async () => {
    const fake = await mount('full');
    pasteImage();
    await settle(10);
    expect(fake.savedFiles).toHaveLength(1);
    expect(fake.savedFiles[0]).toMatchObject({ pane: 'p1', name: 'Pasted image 1.png', mime: 'image/png' });
    expect(chips()).toEqual(['Pasted image 1.png']);
    // Nothing is written on this PC.
    expect(localInvokes.filter((i) => i.cmd === 'attachment_save_pasted' || i.cmd === 'attachment_prepare')).toEqual([]);
    // A far path is never read on this disk: the chip's thumbnail is not asked of this PC.
    expect(localInvokes.filter((i) => i.cmd === 'attachment_preview')).toEqual([]);
    // Send: the far PC gets the message with the chip's file (its own path there).
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(field(), 'what is in this?');
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="chat-composer"] button[type="submit"]')!.click());
    await settle(10);
    const sent = fake.farCalls.find((x) => x.cmd === 'pane_message_send');
    expect(sent?.args).toMatchObject({ paneId: 'p1', text: 'what is in this?' });
    expect((sent?.args.attachments as { name: string; path: string }[])[0]).toMatchObject({ name: 'Pasted image 1.png', path: '/Users/me/app/.potato-workspace/attachments/Pasted image 1.png' });
  });

  it('at Answer the same + is there but the far PC refuses the file, so the box says so and holds no chip', async () => {
    const fake = await mount('answer');
    pasteImage();
    await settle(10);
    expect(fake.savedFiles).toEqual([]);
    expect(chips()).toEqual([]);
    expect(host.querySelector('[data-testid="chat-composer-note"]')?.textContent ?? '').not.toBe('');
  });

  it('a file picked on this PC is read here and its bytes go to the far PC', async () => {
    const fake = await mount('full');
    const client = makeRemoteClient(NODE_MAC, fake);
    const far = farHost(client, fake, { name: 'Mac mini' });
    const got = await prepareAttachments('dev:' + NODE_MAC + ':p1', ['C:/Users/me/notes.pdf'], far);
    expect(localInvokes.some((i) => i.cmd === 'attachment_read_local')).toBe(true);
    expect(fake.savedFiles).toEqual([{ pane: 'p1', name: 'notes.pdf', mime: 'application/pdf', bytes: 8 }]);
    expect(got[0]).toMatchObject({ name: 'notes.pdf', kind: 'file' });
  });
});
