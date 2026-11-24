// @vitest-environment jsdom
// A far chat whose PC is away says so (and is not "Working"); one that ended while the PC was off keeps its header and its last transcript,
// asks nothing of the far PC, and Close only forgets it here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, type RemotePane } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useEnglish } from '../../i18n/test-utils';
import { settle } from '../settings/test-utils';
import { FarPane } from './FarPane';
import { rowOf } from './useDeviceGroups';

useEnglish();
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (cmd: string) => (cmd === 'get_app_install_info' ? { platform: 'win32' } : null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
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

const PANE: RemotePane = { id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'running', title: 'Build the .dmg', lane: 'acp' };
const cockpit = (): CockpitApi =>
  ({
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
  }) as unknown as CockpitApi;

async function mount(state: 'online' | 'offline', ended: boolean, onClosed = vi.fn()) {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state, path: state === 'online' ? 'direct' : null }], panes: { [NODE_MAC]: [PANE] }, chats: { p1: phoneRenderReply(Date.now()).items } });
  fake.farLevels[NODE_MAC] = 'full';
  const row = rowOf(NODE_MAC, { id: PANE.id, agent: PANE.agent_type, title: PANE.title, status: PANE.status, project: 'p', folder: 'app', chat: true });
  await act(async () => root.render(<FarPane device={fake.view.devices[0]!} row={row} rows={[row]} c={cockpit()} api={fake} openRow={() => {}} onClosed={onClosed} ended={ended} />));
  await settle(14);
  return { fake, onClosed };
}
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);

describe('a far chat while its PC is away', () => {
  it('says the PC is offline and is not "Working"', async () => {
    await mount('offline', false);
    expect(q('[data-testid="remote-offline"]')!.textContent).toContain('Mac mini is offline');
    expect(host.textContent).not.toContain('Working');
    // Said once: the banner has it, the message box does not repeat it.
    expect(q('.ck-chat-composer')?.textContent ?? '').not.toContain('is offline');
  });
  it('an online PC shows no such line', async () => {
    await mount('online', false);
    expect(q('[data-testid="remote-offline"]')).toBeNull();
  });
});

describe('a far chat that ended while its PC was off', () => {
  it('keeps the header, asks the far PC for nothing, says it ended; Close forgets it here', async () => {
    const { fake, onClosed } = await mount('online', true);
    expect(q('[data-testid="far-gone"]')!.textContent).toContain('This chat ended while Mac mini was off.');
    expect(q('[data-testid="pane-place"]')!.textContent).toBe('Mac mini');
    // Grey "Ended", never a red "Stopped".
    expect(q('.ck-pane-doing')!.textContent).toBe('Ended');
    expect(host.textContent!.match(/.{20}Stopped.{20}/)).toBeNull();
    expect(host.textContent).toContain('Build the .dmg');
    expect(fake.farCalls.some((x) => x.cmd === 'session_chat_open')).toBe(false);
    await act(async () => q<HTMLButtonElement>('[data-testid="far-gone-close"]')!.click());
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
