// @vitest-environment jsdom
// The auto-detected sandbox ("pm-sbx-main", a Linux place on this PC) in New agent > Where, through the real NewAgentHost page:
// picking it names it in the pill, shows the small form in a column of its own (the Start button stays inside the page, not
// on the window edge), and Start opens an agent in that place. Only the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake } from '../../../dev/devices-fixtures';
import { SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { WslApi } from '../../../lib/wsl';
import { click, settle } from '../../settings/test-utils';
import { NewAgentHost } from './NewAgentHost';

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
  document.body.innerHTML = '';
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
    newAgent: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function fakeWsl(spawned: unknown[][]): WslApi {
  return {
    status: async () => ({
      state: 'ready' as const,
      distros: [
        { name: 'Ubuntu', default: true, version: 2, state: 'Running' },
        { name: 'pm-sbx-main', default: false, version: 2, state: 'Running' },
      ],
    }),
    check: async () => {
      throw new Error('never called');
    },
    placesGet: async () => [{ agentId: 'claude', label: 'Claude', distro: null, found: null, whyNot: null }],
    placeSet: async () => {
      throw new Error('never called');
    },
    spawnInLinux: async (args: unknown, distro: string) => {
      spawned.push([args, distro]);
      return 'wsl-pane-1';
    },
  } as unknown as WslApi;
}

describe('New agent page: the sandbox on this PC', () => {
  it('names the sandbox in the pill, keeps the form in its own column, and starts the agent in the sandbox', async () => {
    const spawned: unknown[][] = [];
    const started: string[] = [];
    const devices = new DevicesFake({ enabled: true, devices: [] });
    await act(async () =>
      root.render(<NewAgentHost c={fakeApi()} where={{ view: devices.view, api: devices, ssh: new SshFake(), wsl: fakeWsl(spawned), onAddDevice: () => {}, onStarted: () => {}, onStartedHere: (id) => started.push(id) }} />),
    );
    await settle(6);
    await click(q('[data-testid="where-pill"]'));
    await settle(4);
    const rows = [...q('.dev-where-menu')!.querySelectorAll('.dev-where-row > span')].map((s) => s.textContent);
    expect(rows).toEqual(['This PC', 'Ubuntu', 'pm-sbx-main', 'Add a device…']);
    await click(q('[data-testid="where-wsl:pm-sbx-main"]'));
    await settle(6);

    // The device name is the one that was picked (not "Ubuntu", not "This PC").
    const pill = q('[data-testid="where-pill"]')!;
    expect(pill.textContent).toContain('pm-sbx-main');
    expect(pill.textContent).not.toContain('Ubuntu');
    // The form sits in the page's own column (padding, a maximum width), so Start can never be pushed to the window edge.
    const page = q('[data-testid="place-page"]')!;
    expect(page).not.toBeNull();
    expect(page.contains(q('[data-testid="place-start"]'))).toBe(true);
    expect(page.contains(pill)).toBe(true);

    await click(q('[data-testid="place-start"]'));
    await settle(4);
    expect(spawned).toEqual([[{ agent_type: 'claude' }, 'pm-sbx-main']]);
    expect(started).toEqual(['wsl-pane-1']);
  });
});
