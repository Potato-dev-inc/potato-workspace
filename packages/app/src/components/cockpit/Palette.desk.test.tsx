// @vitest-environment jsdom
// The palette's "Leaving my desk" row: it opens the sheet while a phone is paired and the switch is off, and turns
// into "I'm back" while it is on. With no phone paired there is no row.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { deskStore, NOT_AWAY, setDeskSheetOpen, useDeskSheetOpen, type DeskAway } from '../../lib/desk-away';
import { tauri } from '../../lib/tauri';
import { Palette } from './Palette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  setDeskSheetOpen(false);
  vi.restoreAllMocks();
  vi.spyOn(tauri, 'getDeskAway').mockResolvedValue(NOT_AWAY);
  await act(async () => deskStore().refresh());
  vi.restoreAllMocks();
});

const cockpit = () =>
  ({
    registry: { paneList: [], panes: new Map() },
    launchEntries: [],
    readyAgents: new Set(),
    names: new Map(),
    selectedId: null,
    mode: 'orchestration',
    theme: 'dark',
    previews: {},
    openSettings: vi.fn(async () => {}),
    notify: vi.fn(),
  }) as unknown as CockpitApi;

const titles = () => [...host.querySelectorAll('.ck-palette-title')].map((n) => n.textContent);
const row = (title: string) => [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.querySelector('.ck-palette-title')?.textContent === title);

function SheetFlag() {
  return <i data-testid="sheet-flag">{String(useDeskSheetOpen())}</i>;
}

async function open(state: DeskAway) {
  vi.spyOn(tauri, 'getDeskAway').mockResolvedValue(state);
  await act(async () =>
    root.render(
      <>
        <Palette c={cockpit()} onClose={() => {}} />
        <SheetFlag />
      </>,
    ),
  );
  await act(async () => deskStore().refresh());
}

describe('palette: Leaving my desk', () => {
  it('has no row while no phone is paired', async () => {
    await open({ away: false, lock_screen: false, phones: 0 });
    expect(titles()).not.toContain('Leaving my desk');
    expect(titles()).not.toContain("I'm back");
  });

  it('offers the switch when a phone is paired, and the row opens the sheet that asks how long', async () => {
    await open({ away: false, lock_screen: false, phones: 1 });
    expect(titles()).toContain('Leaving my desk');
    expect(titles()).not.toContain("I'm back");
    act(() => row('Leaving my desk')!.click());
    expect(host.querySelector('[data-testid="sheet-flag"]')!.textContent).toBe('true');
  });

  it("turns into I'm back while it is on, and the row ends it", async () => {
    await open({ away: true, length: 'until_back', until_ms: null, by: 'pc', lock_screen: false, phones: 1 });
    expect(titles()).toContain("I'm back");
    expect(titles()).not.toContain('Leaving my desk');
    const end = vi.spyOn(tauri, 'endDeskAway').mockResolvedValue({ away: false, lock_screen: false, phones: 1 });
    await act(async () => row("I'm back")!.click());
    expect(end).toHaveBeenCalledTimes(1);
  });
});
