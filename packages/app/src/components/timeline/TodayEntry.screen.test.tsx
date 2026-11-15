// @vitest-environment jsdom
// The two ways in to the Today page, through the real parent screens: the clock button at the bottom of the
// sidebar, and "See the whole day" in a chat's History tab. Both are absent until the Labs switch is on.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, FIXTURE_TURN_FILES, sampleDay, sampleNowDiff } from '../../dev/timeline-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { CheckpointList, CheckpointsApi } from '../../lib/cockpit-api';
import type { ShipApi } from '../../lib/ship-api';
import type { TimelineApi } from '../../lib/timeline';
import { History } from '../cockpit/History';
import { Sidebar } from '../cockpit/Sidebar';
import { TodayPage } from './TodayPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
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

const timelineApi: TimelineApi = {
  day: vi.fn(async () => sampleDay()),
  pointDiff: vi.fn(async () => FIXTURE_TURN_FILES),
  nowDiff: vi.fn(async () => sampleNowDiff()),
  filePatch: vi.fn(async () => ({ patch: '', truncated: false })),
  goBack: vi.fn(async () => ({ safetyId: null, written: 0, removed: 0, failed: [] })),
};

/** The main area shows the Today page when the sidebar's button opens it, the way CockpitApp does. */
function Screen({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cockpit">
      <Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} onOpenToday={enabled ? () => setOpen(true) : undefined} todayOpen={open && enabled} />
      {open && enabled && <TodayPage api={timelineApi} onClose={() => setOpen(false)} notify={() => {}} now={() => FIXTURE_NOW} refreshMs={0} />}
    </div>
  );
}

const todayButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Today"]');

describe('the sidebar button', () => {
  it('is there with the Labs switch on, and opens the page with its lanes and marks', async () => {
    await act(async () => root.render(<Screen enabled />));
    await act(async () => {});
    expect(todayButton()).not.toBeNull();
    expect(host.querySelector('[data-testid="timeline-page"]')).toBeNull();
    await act(async () => todayButton()!.click());
    await act(async () => {});
    await act(async () => {});
    expect(host.querySelector('[data-testid="timeline-page"]')).not.toBeNull();
    expect([...host.querySelectorAll('.ck-tl-name-text')].map((n) => n.textContent)).toEqual(['pm-workspace', 'potato-site', 'notes']);
    expect(host.querySelectorAll('.ck-tl-mark').length).toBeGreaterThan(50);
    expect(todayButton()!.getAttribute('aria-current')).toBe('page');
  });

  it('is absent with the Labs switch off', async () => {
    await act(async () => root.render(<Screen enabled={false} />));
    await act(async () => {});
    expect(todayButton()).toBeNull();
  });
});

describe('the History tab link', () => {
  const listing: CheckpointList = {
    state: 'ok',
    message: '',
    items: [{ id: '1', commit: 'c1', paneId: 'p1', turn: 1, kind: 'after', label: 'After turn 1', note: '', atMs: 1000, files: 1, added: 1, deleted: 0 }],
  };
  const api = { checkpointsList: vi.fn(async () => listing), checkpointDiff: vi.fn(), checkpointRestore: vi.fn(), checkpointUndoLast: vi.fn() } as unknown as CheckpointsApi;
  const find = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'See the whole day');

  it('opens the Today page when the switch is on', async () => {
    const open = vi.fn();
    await act(async () => root.render(<History paneId="p1" status="idle" now={5000} notify={() => {}} api={api} onSeeDay={open} />));
    await act(async () => {});
    expect(find()).toBeDefined();
    await act(async () => find()!.click());
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows no link without it', async () => {
    await act(async () => root.render(<History paneId="p1" status="idle" now={5000} notify={() => {}} api={api} />));
    await act(async () => {});
    expect(find()).toBeUndefined();
  });
});
