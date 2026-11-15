// @vitest-environment jsdom
// The palette has "What's new" (opens the tour) and "Feature guide" (asks the cockpit for the guide page).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { OPEN_GUIDE_EVENT, resetWhatsNewForTests, setRunningVersion, useWhatsNewState } from '../../whatsnew/store';
import { Palette } from './Palette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  resetWhatsNewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

const c = {
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
} as unknown as CockpitApi;

const rowFor = (title: string) => [...host.querySelectorAll<HTMLElement>('[role="option"]')].find((r) => r.querySelector('.ck-palette-title')?.textContent === title);

function Probe() {
  const s = useWhatsNewState();
  return <output data-testid="tour">{s.tour?.version ?? 'closed'}</output>;
}

describe('palette: What\'s new and Feature guide', () => {
  it("What's new opens the tour", () => {
    setRunningVersion('1.1.1');
    act(() =>
      root.render(
        <>
          <Palette c={c} onClose={vi.fn()} />
          <Probe />
        </>,
      ),
    );
    act(() => rowFor("What's new")!.click());
    expect(host.querySelector('[data-testid="tour"]')?.textContent).toBe('1.1.1');
  });

  it('Feature guide asks the cockpit for the guide page', () => {
    const seen = vi.fn();
    window.addEventListener(OPEN_GUIDE_EVENT, seen);
    act(() => root.render(<Palette c={c} onClose={vi.fn()} />));
    act(() => rowFor('Feature guide')!.click());
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_GUIDE_EVENT, seen);
  });
});
