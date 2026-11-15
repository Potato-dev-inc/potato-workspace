// @vitest-environment jsdom
// The sidebar's Team row: always there when the cockpit passes it, shows what waits for me, and opens the Team page (People first).
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamConfig, teamState } from '../../dev/team-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import type { TeamApi } from '../../lib/team';
import { resetRememberedTab } from '../team-page/TeamPage';
import { TeamHost } from '../team-page/TeamHost';
import { Sidebar } from './Sidebar';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetRememberedTab();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
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
const team = {
  state: async () => teamState({ presence: [] }),
  configGet: async () => teamConfig(),
  defaultName: async () => 'Leo',
  onChanged: async () => () => {},
  onDraft: async () => () => {},
} as unknown as TeamApi;

function Screen({ waiting = 0 }: { waiting?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} team={{ open, waiting }} onOpenTeam={() => setOpen(true)} />
      {open && <TeamHost api={team} lendClient={undefined} />}
    </div>
  );
}
const row = () => host.querySelector<HTMLButtonElement>('[data-testid="side-team"]');

describe('sidebar: Team row', () => {
  it('opens the Team page with People on screen, and the row is the active one', async () => {
    await act(async () => root.render(<Screen />));
    expect(row()).not.toBeNull();
    expect(host.querySelector('[data-testid="team-page"]')).toBeNull();
    await act(async () => row()!.click());
    await act(async () => {});
    await act(async () => {});
    expect(host.querySelector('[data-testid="team-page"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tab-people"]')!.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="person-m-maya"]')).not.toBeNull();
    expect(row()!.className).toContain('is-active');
  });

  it('shows the number of things that wait for me', async () => {
    await act(async () => root.render(<Screen waiting={3} />));
    expect(host.querySelector('[data-testid="side-team-count"]')!.textContent).toBe('3');
  });

  it('shows no number when nothing waits', async () => {
    await act(async () => root.render(<Screen />));
    expect(host.querySelector('[data-testid="side-team-count"]')).toBeNull();
  });
});
