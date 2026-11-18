// @vitest-environment jsdom
// The sidebar's device groups (Labs `devices_enabled`): a group per paired device with its rows, the device mark, a state
// word, greyed with "Last seen" when the link drops, and a click that opens the chat or terminal of that device. Through the
// real Sidebar, the real group hook and the real remote view; only the device command layer is the fake.
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { RemotePaneView } from '../devices/RemotePaneView';
import { useDeviceGroups, type RemoteRow } from '../devices/useDeviceGroups';
import { Sidebar } from './Sidebar';
import { FAR_LEVEL_POLL_MS } from '../../lib/runtime/farLevel';

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
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
});

function fakeApi(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

/** The wiring of CockpitApp: the hook feeds the sidebar, and a chosen remote row fills the main area. */
function Screen({ fake }: { fake: DevicesFake }) {
  const groups = useDeviceGroups(fake);
  const [row, setRow] = useState<RemoteRow | null>(null);
  const device = row ? groups.groups.find((g) => g.device.node === row.node)?.device : undefined;
  return (
    <div>
      <Sidebar
        c={fakeApi()}
        onOpenPalette={() => {}}
        ship={ship}
        devices={groups.enabled ? { groups: groups.groups, selectedKey: row?.key ?? null, onOpen: setRow, onRetry: groups.refresh } : undefined}
      />
      {row && device && <RemotePaneView device={device} row={row} api={fake} onRetry={groups.refresh} />}
    </div>
  );
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};
const group = () => host.querySelector<HTMLElement>(`[data-testid="device-group-${NODE_MAC}"]`);
const rows = () => [...host.querySelectorAll<HTMLButtonElement>(`[data-pane-row^="dev:${NODE_MAC}:"]`)];

async function mount(fake: DevicesFake) {
  await act(async () => root.render(<Screen fake={fake} />));
  await flush();
}

const seeded = () => new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP], panes: { [NODE_MAC]: MAC_PANES } });

describe('sidebar: device groups', () => {
  it('shows a Mac mini group with its rows, a device mark', async () => {
    await mount(seeded());
    expect(group()!.textContent).toContain('Mac mini');
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Build the .dmg'), expect.stringContaining('Terminal')]);
    expect(host.querySelector('[data-testid="this-pc-head"]')!.textContent).toBe('This PC');
    expect(group()!.querySelector('.dev-group-head')!.textContent).toBe('Mac mini');
    expect(group()!.querySelector('.ck-caption')!.textContent).toBe('Projects');
    // One tag only: the section heading names the PC. The rows are the normal row components, grouped under a project header like this PC's.
    expect(rows()[0]!.querySelector('.dev-mark')).toBeNull();
    expect(rows()[0]!.classList.contains('ck-row')).toBe(true);
    expect(group()!.querySelector('.ck-proj .ck-proj-head')).not.toBeNull();
    // A device that is offline and never showed anything has no group.
    expect(host.querySelector(`[data-testid="device-group-${WORK_LAPTOP.node}"]`)).toBeNull();
    // Remote rows use the namespaced id.
    expect(rows()[0]!.dataset.paneRow).toBe(`dev:${NODE_MAC}:p1`);
  });

  it('greys the group and says offline with the last seen time when the link drops, and keeps the rows', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', path: null, last_seen: Math.floor(new Date(2026, 10, 15, 14, 2).getTime() / 1000) }));
    await flush();
    const g = group()!;
    expect(g.dataset.state).toBe('offline');
    expect(g.className).toContain('is-off');
    expect(g.querySelector('.dev-word')!.textContent).toBe('offline');
    expect(g.textContent).toContain('Last seen 14:02');
    expect(rows()).toHaveLength(2);
    // The last rows stay openable (the last transcript is read-only).
    expect(rows().every((r) => !r.disabled)).toBe(true);
    // The link comes back: the rows are live again.
    await act(async () => fake.setDevice(NODE_MAC, { state: 'online', path: 'direct' }));
    await flush();
    expect(group()!.className).not.toContain('is-off');
    expect(rows().every((r) => !r.disabled)).toBe(true);
  });

  it('says not allowed when that device does not let this PC in', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'not_allowed', path: null }));
    await flush();
    expect(group()!.querySelector('.dev-word')!.textContent).toBe('not allowed');
    expect(group()!.textContent).toContain('does not let this PC run agents');
  });

  it('remembers a folded group', async () => {
    await mount(seeded());
    await act(async () => group()!.querySelector<HTMLButtonElement>('.dev-group-head')!.click());
    expect(rows()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(seeded());
    expect(group()).not.toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('opens the terminal of the other device from its row, and types into it when the device allows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      await terminalStory();
    } finally {
      vi.useRealTimers();
    }
  });

  async function terminalStory() {
    const fake = seeded();
    await mount(fake);
    await act(async () => rows()[1]!.click());
    await flush();
    expect(host.querySelector('[data-testid="remote-pane"]')).not.toBeNull();
    // The screen is live: the far side pushes it, nothing is polled.
    expect(fake.screenStarts).toEqual([`${NODE_MAC}:p2`]);
    await act(async () => fake.emitScreen({ node: NODE_MAC, pane_id: 'p2', content: '$ make dmg' }));
    expect(host.querySelector('[data-testid="remote-screen"]')!.textContent).toContain('make dmg');
    expect(fake.requests.some((r) => r.path.endsWith('/screen'))).toBe(false);
    const input = host.querySelector<HTMLInputElement>('[data-testid="remote-input"]')!;
    expect(input).not.toBeNull();
    // The far PC takes the right away (it is its to say: asked again every few seconds): no typing line any more.
    fake.farLevels[NODE_MAC] = 'answer';
    await act(async () => vi.advanceTimersByTimeAsync(FAR_LEVEL_POLL_MS * 1.3 + 100));
    await flush();
    expect(host.querySelector('[data-testid="remote-input"]')).toBeNull();
    expect(host.querySelector('[data-testid="remote-pane"]')).not.toBeNull();
  }

  it('opens the chat of the other device in the normal chat view', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => rows()[0]!.click());
    await flush();
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
    expect(host.querySelector('.ph')).toBeNull();
    expect(fake.requests.some((r) => r.path.startsWith('/pclink/sessions/p1/transcript'))).toBe(true);
  });

  it('says asleep, closed and offline in the group, each with its exact words, and Try again asks again', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'asleep', path: null }));
    await flush();
    expect(group()!.querySelector('.dev-word')!.textContent).toBe('asleep');
    expect(group()!.querySelector('[data-notice="state"]')!.textContent).toContain('Asleep or off.');
    // The last rows stay openable (the last transcript is read-only).
    expect(rows().every((r) => !r.disabled)).toBe(true);
    const before = fake.stateCalls;
    await act(async () => group()!.querySelector<HTMLButtonElement>('[data-testid="try-again"]')!.click());
    await flush();
    expect(fake.stateCalls).toBeGreaterThan(before);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'closed' }));
    await flush();
    expect(group()!.querySelector('.dev-word')!.textContent).toBe('closed');
    expect(group()!.textContent).toContain('Potato Workspace is closed on Mac mini.');
    expect(group()!.querySelector('[data-testid="try-again"]')).toBeNull();
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', last_seen: Math.floor(new Date(2026, 10, 15, 14, 2).getTime() / 1000) }));
    await flush();
    expect(group()!.textContent).toContain('Offline. Last seen 14:02.');
    expect(group()!.querySelector('[data-testid="try-again"]')).not.toBeNull();
  });

  it('says needs you when a prompt waits for a person there, even for a device with no rows', async () => {
    const fake = new DevicesFake({
      enabled: true,
      devices: [{ ...MAC_MINI, needs_person: [{ pane: 'p1', what: 'a password box is open there' }] }, { ...WORK_LAPTOP, state: 'online', path: 'relay', needs_person: [{ pane: 'x', what: 'a system dialog' }] }],
      panes: { [NODE_MAC]: MAC_PANES },
    });
    await mount(fake);
    expect(group()!.querySelector('.dev-word')!.textContent).toBe('needs you');
    expect(group()!.textContent).toContain('Needs a person at Mac mini: a password box is open there');
    expect(rows().every((r) => !r.disabled)).toBe(true);
    const laptop = host.querySelector(`[data-testid="device-group-${WORK_LAPTOP.node}"]`)!;
    expect(laptop.textContent).toContain('Needs a person at Work laptop: a system dialog');
  });

  it('shows the not allowed words in the group', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'not_allowed', path: null }));
    await flush();
    expect(group()!.textContent).toContain('Mac mini does not let this PC run agents. Turn it on there: Connect › My PCs.');
  });

  it('draws nothing of it while the Labs switch is off', async () => {
    await mount(new DevicesFake({ enabled: false, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } }));
    expect(host.querySelector('[data-testid^="device-group-"]')).toBeNull();
    expect(host.querySelector('[data-testid="this-pc-head"]')).toBeNull();
  });
});

describe('sidebar: another PC is a section like This PC', () => {
  const kids = () =>
    new DevicesFake({
      enabled: true,
      devices: [MAC_MINI],
      panes: { [NODE_MAC]: [...MAC_PANES, { id: 'p3', agent_type: 'claude', cwd: '/Users/me/app', status: 'error', title: 'Minion', lane: 'acp', parent_pane_id: 'p1' }] },
    });

  it('uses the same agent row component as a local row, with a nested helper under its starter behind the same "N helpers" chip, and an error pill', async () => {
    await mount(kids());
    const g = group()!;
    const all = [...g.querySelectorAll<HTMLElement>('[data-pane-row]')];
    expect(all).toHaveLength(3);
    for (const r of all) {
      expect(r.classList.contains('ck-row')).toBe(true);
      expect(r.classList.contains('ck-row--slim')).toBe(true);
      expect(r.querySelector('.ck-row-glyph .ck-mark')).not.toBeNull();
    }
    expect(g.querySelector('.ck-node > .ck-helpers .ck-helper-chip')!.textContent).toBe('1 agent');
    const minion = g.querySelector<HTMLElement>(`[data-pane-row="dev:${NODE_MAC}:p3"]`)!;
    expect(minion.closest('.ck-helpers')).not.toBeNull();
    expect(minion.querySelector('[data-testid="row-spinoff-mark"]')).not.toBeNull();
    expect(minion.querySelector('.ck-row-pill--error')).not.toBeNull();
    // Row actions this PC cannot do on another PC's agent are disabled with a plain reason.
    const more = g.querySelector<HTMLButtonElement>('.ck-row-more')!;
    expect(more.disabled).toBe(true);
    expect(more.title).toContain('not available');
  });

  it('remembers a folded project and a folded helper group', async () => {
    await mount(kids());
    await act(async () => group()!.querySelector<HTMLButtonElement>('.ck-helper-chip')!.click());
    expect(group()!.querySelector(`[data-pane-row="dev:${NODE_MAC}:p3"]`)).toBeNull();
    await act(async () => group()!.querySelector<HTMLButtonElement>('.ck-proj-head button')!.click());
    expect(rows()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(kids());
    expect(rows()).toHaveLength(0);
    expect(window.localStorage.getItem('pm.devices.foldedProjects')).toContain(NODE_MAC);
  });

  it('an offline PC keeps its last rows openable, and its last transcript is readable and read-only', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(fake);
    await act(async () => rows()[0]!.click());
    await flush(12);
    await act(async () => new Promise((r) => setTimeout(r, 2100)));
    await flush();
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
    expect(window.localStorage.getItem(`pm.remoteChat.device:${NODE_MAC}:p1`)).not.toBeNull();
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', path: null }));
    await flush();
    expect(rows().every((r) => !r.disabled)).toBe(true);
    // Opened while the PC is away: the kept transcript shows, and there is no message box.
    await act(async () => rows()[1]!.click());
    await act(async () => rows()[0]!.click());
    await flush(12);
    expect(host.querySelector('[data-testid="session-chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-composer"]')).toBeNull();
    expect(host.textContent).toContain('create a potato workspace overview page');
  });

  it('keys no local state with the far pane id: the chat and its box use device:<node>:<pane>', async () => {
    await mount(seeded());
    await act(async () => rows()[0]!.click());
    await flush(12);
    const box = host.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer"] textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'half written');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => new Promise((r) => setTimeout(r, 700)));
    // The draft is saved in one JSON map: it holds the key with the PC in it, and never the bare far pane id.
    const drafts = JSON.parse(window.localStorage.getItem('pm.composerDrafts') ?? '{}') as Record<string, { text: string }>;
    expect(drafts[`device:${NODE_MAC}:p1`]?.text).toBe('half written');
    expect(Object.keys(drafts)).not.toContain('p1');
    const keys = Object.keys(window.localStorage);
    expect(keys.some((k) => k.includes('p1') && !k.includes(`device:${NODE_MAC}:p1`) && /draft|plan|view/i.test(k))).toBe(false);
  });

  it('a PC that lets this one only watch says plainly what works', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(fake);
    await act(async () => rows()[0]!.click());
    await flush(12);
    expect(host.querySelector('[data-testid="remote-watch-only"]')!.textContent).toBe('You can watch here. Sending a message to Mac mini needs Answer there.');
  });
});
