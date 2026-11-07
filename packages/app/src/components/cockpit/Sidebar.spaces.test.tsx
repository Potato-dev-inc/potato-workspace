// @vitest-environment jsdom
// The sidebar's Spaces row (Labs `spaces_enabled`): shown only with the flag on, and clicking it opens the Spaces page.
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ShipApi } from '../../lib/ship-api';
import type { SpacesView } from '../../lib/spaces';
import { Sidebar } from './Sidebar';

vi.mock('../../lib/spaces', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/spaces')>();
  const empty: SpacesView = { spaces: [], requests: [], joining: [], invites: [], online: true, relayed: false, showOnline: true };
  return {
    ...orig,
    useSpaces: () => ({
      view: empty,
      error: null,
      create: async () => null,
      invite: async () => null,
      cancelInvite: async () => {},
      join: async () => false,
      answer: async () => {},
      cancelJoin: async () => {},
    }),
    useSpace: () => ({ detail: null, error: null, reload: () => {} }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { SpacesPage } from '../spaces/SpacesPage';

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

/** A main area that shows the Spaces page when the row opens it, the way CockpitApp does. */
function Screen({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Sidebar
        c={fakeApi()}
        onOpenPalette={() => {}}
        ship={ship}
        spaces={{ enabled }}
        spacesOpen={open && enabled}
        onOpenSpaces={() => setOpen(true)}
      />
      {open && enabled && <SpacesPage />}
    </div>
  );
}

async function render(enabled: boolean) {
  await act(async () => root.render(<Screen enabled={enabled} />));
  await act(async () => {});
}
const spacesRow = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Spaces') ?? null;

describe('sidebar: Spaces row and page', () => {
  it('the row appears when Labs spaces is on', async () => {
    await render(true);
    expect(spacesRow()).not.toBeNull();
  });

  it('the row is absent when Labs spaces is off', async () => {
    await render(false);
    expect(spacesRow()).toBeNull();
  });

  it('clicking the row opens the Spaces page and marks the row active', async () => {
    await render(true);
    expect(host.textContent).not.toContain('Chat with friends in small groups');
    await act(async () => spacesRow()!.click());
    await act(async () => {});
    expect(host.textContent).toContain('Chat with friends in small groups, computer to computer. No server keeps your messages.');
    expect(spacesRow()!.getAttribute('aria-current')).toBe('page');
  });
});
