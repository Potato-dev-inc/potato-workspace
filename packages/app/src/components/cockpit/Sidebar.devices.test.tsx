// @vitest-environment jsdom
// The sidebar's other PCs (Labs `devices_enabled`): their projects sit in the one Projects list, each with a badge beside
// the name (the PC's name), their agent rows are the normal rows, offline/asleep/closed/needs-you notices sit above them, and a
// click opens the chat or terminal of that device. Through the real Sidebar, the real group hook and the real remote view;
// only the device command layer is the fake.
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { phoneRenderReply } from '../../dev/phone-render-fixture';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import { FarPane } from '../devices/FarPane';
import { useDeviceGroups, type RemoteRow } from '../devices/useDeviceGroups';
import { Sidebar } from './Sidebar';
import { FAR_LEVEL_POLL_MS } from '../../lib/runtime/farLevel';

vi.mock('../../terminal', () => ({
  // A far terminal is the real viewport; xterm itself needs a browser, so these screens draw it with a stub session.
  TerminalSession: class {
    mount() {}
    dispose() {}
    nudgeReflow() {
      return true;
    }
    setReprintsOnResize() {}
    followHeldPty() {}
    afterReclaim() {}
    setKnownPtyGrid() {}
    isScrolledUp() {
      return false;
    }
    getSelection() {
      return '';
    }
    setPtyDimensions() {}
    refreshFromSource() {}
    measureFitGrid() {
      return null;
    }
  },
}));


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
  const [api] = useState(fakeApi);
  const device = row ? groups.groups.find((g) => g.device.node === row.node)?.device : undefined;
  return (
    <div>
      <Sidebar
        c={fakeApi()}
        onOpenPalette={() => {}}
        ship={ship}
        devices={groups.enabled ? { groups: groups.groups, selectedKey: row?.key ?? null, onOpen: setRow, onRetry: groups.refresh } : undefined}
      />
      {row && device && <FarPane device={device} row={row} rows={groups.groups.find((g) => g.device.node === row.node)?.rows ?? [row]} c={api} api={fake} openRow={(key) => setRow(groups.groups.flatMap((g) => g.rows).find((r) => r.key === key) ?? null)} onRetry={groups.refresh} />}
    </div>
  );
}

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};
/** Every element of another PC's projects and notices (they carry its node id). */
const nodeEls = (node: string) => [...host.querySelectorAll<HTMLElement>(`[data-remote-node="${node}"]`)];
const textOf = (node: string) => nodeEls(node).map((el) => el.textContent).join(' | ');
/** The state word beside that PC's project name ("offline", "asleep", "needs you"...). */
const wordOf = (node: string) => host.querySelector<HTMLElement>(`.ck-proj[data-remote-node="${node}"] .dev-word`)?.textContent;
/** That PC's project card (the first one). */
const projectOf = (node: string) => host.querySelector<HTMLElement>(`.ck-proj[data-remote-node="${node}"]`);
/** Inside that PC's projects and notices. */
const within = (sel: string) => host.querySelector<HTMLElement>(`[data-remote-node="${NODE_MAC}"] ${sel}`);
const rows = () => [...host.querySelectorAll<HTMLButtonElement>(`[data-pane-row^="dev:${NODE_MAC}:"]`)];

async function mount(fake: DevicesFake) {
  await act(async () => root.render(<Screen fake={fake} />));
  await flush();
}

const seeded = () => new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP], panes: { [NODE_MAC]: MAC_PANES } });

describe('sidebar: other PCs are projects in the one Projects list', () => {
  it('shows a Mac mini project with its rows, a device badge beside the name, and no device section', async () => {
    await mount(seeded());
    expect(textOf(NODE_MAC)).toContain('Mac mini');
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining('Build the .dmg'), expect.stringContaining('Terminal')]);
    expect(host.querySelector('[data-testid="proj-badge"]')!.textContent).toBe('Mac mini');
    expect(projectOf(NODE_MAC)!.querySelector('.ck-proj-head')).not.toBeNull();
    // No device section and no "This PC" heading any more: the Projects list is one list.
    expect(host.querySelector('[data-testid^="device-group-"]')).toBeNull();
    expect(host.querySelector('[data-testid="this-pc-head"]')).toBeNull();
    expect(host.querySelector('.dev-group-head')).toBeNull();
    // One tag only: the badge names the PC. The rows are the normal row components, under a project header like this PC's.
    expect(rows()[0]!.querySelector('.dev-mark')).toBeNull();
    expect(rows()[0]!.classList.contains('ck-row')).toBe(true);
    // A device that is offline and never showed anything has no project.
    expect(host.querySelector(`[data-remote-node="${WORK_LAPTOP.node}"]`)).toBeNull();
    // Remote rows use the namespaced id.
    expect(rows()[0]!.dataset.paneRow).toBe(`dev:${NODE_MAC}:p1`);
  });

  it('greys the project and says offline with the last seen time when the link drops, and keeps the rows', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', path: null, last_seen: Math.floor(new Date(2026, 10, 15, 14, 2).getTime() / 1000) }));
    await flush();
    expect(projectOf(NODE_MAC)!.dataset.state).toBe('offline');
    expect(projectOf(NODE_MAC)!.className).toContain('is-off');
    expect(wordOf(NODE_MAC)).toBe('offline');
    expect(textOf(NODE_MAC)).toContain('Last seen 14:02');
    expect(rows()).toHaveLength(2);
    // The last rows stay openable (the last transcript is read-only).
    expect(rows().every((r) => !r.disabled)).toBe(true);
    // The link comes back: the rows are live again.
    await act(async () => fake.setDevice(NODE_MAC, { state: 'online', path: 'direct' }));
    await flush();
    expect(projectOf(NODE_MAC)!.className).not.toContain('is-off');
    expect(rows().every((r) => !r.disabled)).toBe(true);
  });

  it('says not allowed when that device does not let this PC in', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'not_allowed', path: null }));
    await flush();
    expect(textOf(NODE_MAC)).toContain('does not let this PC run agents');
  });

  it('remembers a folded project', async () => {
    await mount(seeded());
    await act(async () => host.querySelector<HTMLButtonElement>(`.ck-proj[data-remote-node="${NODE_MAC}"] .ck-proj-toggle`)!.click());
    expect(rows()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(seeded());
    expect(projectOf(NODE_MAC)).not.toBeNull();
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
    // The far terminal is the normal terminal, fed by the far PC's pane stream over its event stream; the old plain-text routes are not used.
    expect(host.querySelector('[data-testid="remote-terminal"]')).not.toBeNull();
    expect(fake.subscribed.has(NODE_MAC)).toBe(true);
    expect(fake.requests.some((r) => r.path.endsWith('/screen') || r.path.endsWith('/input'))).toBe(false);
    // The far PC takes the right away (it is its to say: asked again every few seconds): the terminal stays, it only stops offering the far list.
    fake.farLevels[NODE_MAC] = 'answer';
    await act(async () => vi.advanceTimersByTimeAsync(FAR_LEVEL_POLL_MS * 1.3 + 100));
    await flush();
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

  it('says asleep, closed and offline beside the project, each with its exact words, and Try again asks again', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'asleep', path: null }));
    await flush();
    expect(wordOf(NODE_MAC)).toBe('asleep');
    expect(within('[data-notice="state"]')!.textContent).toContain('Asleep or off.');
    // The last rows stay openable (the last transcript is read-only).
    expect(rows().every((r) => !r.disabled)).toBe(true);
    const before = fake.stateCalls;
    await act(async () => within('[data-testid="try-again"]')!.click());
    await flush();
    expect(fake.stateCalls).toBeGreaterThan(before);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'closed' }));
    await flush();
    expect(wordOf(NODE_MAC)).toBe('closed');
    expect(textOf(NODE_MAC)).toContain('Potato Workspace is closed on Mac mini.');
    expect(within('[data-testid="try-again"]')).toBeNull();
    await act(async () => fake.setDevice(NODE_MAC, { state: 'offline', last_seen: Math.floor(new Date(2026, 10, 15, 14, 2).getTime() / 1000) }));
    await flush();
    expect(textOf(NODE_MAC)).toContain('Offline. Last seen 14:02.');
    expect(within('[data-testid="try-again"]')).not.toBeNull();
  });

  it('says needs you when a prompt waits for a person there, even for a device with no rows', async () => {
    const fake = new DevicesFake({
      enabled: true,
      devices: [{ ...MAC_MINI, needs_person: [{ pane: 'p1', what: 'a password box is open there' }] }, { ...WORK_LAPTOP, state: 'online', path: 'relay', needs_person: [{ pane: 'x', what: 'a system dialog' }] }],
      panes: { [NODE_MAC]: MAC_PANES },
    });
    await mount(fake);
    expect(wordOf(NODE_MAC)).toBe('needs you');
    expect(textOf(NODE_MAC)).toContain('Needs a person at Mac mini: a password box is open there');
    expect(rows().every((r) => !r.disabled)).toBe(true);
    expect(textOf(WORK_LAPTOP.node)).toContain('Needs a person at Work laptop: a system dialog');
  });

  it('shows the not allowed words for that PC', async () => {
    const fake = seeded();
    await mount(fake);
    await act(async () => fake.setDevice(NODE_MAC, { state: 'not_allowed', path: null }));
    await flush();
    expect(textOf(NODE_MAC)).toContain('Mac mini does not let this PC run agents. Turn it on there: Connect › My PCs.');
  });

  it('draws nothing of it while the Labs switch is off', async () => {
    await mount(new DevicesFake({ enabled: false, devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } }));
    expect(host.querySelector('[data-remote-node]')).toBeNull();
    expect(host.querySelector('[data-testid="proj-badge"]')).toBeNull();
  });
});

describe('sidebar: another PC is projects like This PC', () => {
  const kids = () =>
    new DevicesFake({
      enabled: true,
      devices: [MAC_MINI],
      panes: { [NODE_MAC]: [...MAC_PANES, { id: 'p3', agent_type: 'claude', cwd: '/Users/me/app', status: 'error', title: 'Minion', lane: 'acp', parent_pane_id: 'p1', started_as: 'spin_off' }] },
    });

  it('uses the same agent row component as a local row, with a nested helper under its starter behind the same "N helpers" chip, and an error pill', async () => {
    await mount(kids());
    const all = [...host.querySelectorAll<HTMLElement>(`[data-remote-node="${NODE_MAC}"] [data-pane-row]`)];
    expect(all).toHaveLength(3);
    for (const r of all) {
      expect(r.classList.contains('ck-row')).toBe(true);
      expect(r.classList.contains('ck-row--slim')).toBe(true);
      expect(r.querySelector('.ck-row-glyph .ck-mark')).not.toBeNull();
    }
    expect(within('.ck-node > .ck-helpers .ck-helper-chip')!.textContent).toBe('1 agent');
    const minion = within(`[data-pane-row="dev:${NODE_MAC}:p3"]`)!;
    expect(minion.closest('.ck-helpers')).not.toBeNull();
    expect(minion.querySelector('[data-testid="row-spinoff-mark"]')).not.toBeNull();
    expect(minion.querySelector('.ck-row-pill--error')).not.toBeNull();
    // Row actions this PC cannot do on another PC's agent are disabled with a plain reason.
    const more = within('.ck-row-more') as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expect(more.title).toContain('not available');
  });

  it('remembers a folded project and a folded helper group', async () => {
    await mount(kids());
    await act(async () => within('.ck-helper-chip')!.click());
    expect(within(`[data-pane-row="dev:${NODE_MAC}:p3"]`)).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(`.ck-proj[data-remote-node="${NODE_MAC}"] .ck-proj-toggle`)!.click());
    expect(rows()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(kids());
    expect(rows()).toHaveLength(0);
    expect(window.localStorage.getItem('pm.devices.foldedProjects')).toContain(NODE_MAC);
  });

  it('keys no local state with the far pane id: the chat and its box use dev:<node>:<pane>', async () => {
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
    expect(drafts[`dev:${NODE_MAC}:p1`]?.text).toBe('half written');
    expect(Object.keys(drafts)).not.toContain('p1');
    const keys = Object.keys(window.localStorage);
    expect(keys.some((k) => k.includes('p1') && !k.includes(`dev:${NODE_MAC}:p1`) && /draft|plan|view/i.test(k))).toBe(false);
  });

  it('a PC that lets this one only watch says plainly what works', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: MAC_PANES }, chats: { p1: phoneRenderReply(Date.now()).items } });
    await mount(fake);
    await act(async () => rows()[0]!.click());
    await flush(12);
    // The same message box, switched off, with the one reason (no other box, no extra line).
    expect(host.querySelector('[data-testid="remote-watch-only"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-composer"] textarea')!.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('[data-testid="chat-composer"]')!.textContent).toContain('You can watch here. Sending a message to Mac mini needs Answer there.');
  });
});
