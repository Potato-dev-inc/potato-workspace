// @vitest-environment jsdom
// "Today" on the phone, through the real menu: the strip, the list by hour, a point's sheet with its two counts,
// and the go back behind two steps (a sheet, then a press and hold), with Undo after it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, FIXTURE_TURN_FILES, PM, SAMPLE_PATCH, sampleDay, sampleNowDiff } from '../../dev/timeline-fixtures';
import type { BridgeClient } from '../../lib/bridge-types';
import { bridgeTimelineApi, type PointRef, type TimelineApi } from '../../lib/timeline';
import { HOLD_MS } from './HoldButton';
import { MenuSheet } from './MobileSheet';
import { PhoneToday } from './PhoneToday';
import type { PaneLite } from '../timeline/refusal';

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
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function fakeApi(backError?: string) {
  const goBack: PointRef[] = [];
  const api: TimelineApi = {
    day: vi.fn(async () => sampleDay()),
    pointDiff: vi.fn(async () => FIXTURE_TURN_FILES),
    nowDiff: vi.fn(async () => {
      if (backError) throw new Error(backError);
      return sampleNowDiff();
    }),
    filePatch: vi.fn(async () => ({ patch: SAMPLE_PATCH, truncated: false })),
    goBack: vi.fn(async (p) => {
      goBack.push(p);
      return { safetyId: '9', written: 3, removed: 1, failed: [] };
    }),
  };
  return { api, goBack };
}

async function show(api: TimelineApi, panes: PaneLite[] = []) {
  await act(async () => root.render(<PhoneToday api={api} panes={panes} onClose={() => {}} now={() => FIXTURE_NOW} />));
  await act(async () => {});
  await act(async () => {});
}
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.ph-tl-row')];
const sheetText = () => document.querySelector('[data-testid="phone-point"]')?.textContent ?? '';
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await act(async () => {});
}

describe('phone Today: the day', () => {
  it('shows a strip of ticks and a list by hour, newest first', async () => {
    await show(fakeApi().api);
    expect(document.querySelectorAll('.ph-tl-tick').length).toBeGreaterThan(80);
    expect(document.querySelectorAll('.ph-tl-handle')).toHaveLength(1);
    const hours = [...document.querySelectorAll('.ph-tl-hourh')].map((h) => h.textContent);
    expect(hours[0]).toBe('15:00');
    expect([...hours].sort().reverse()).toEqual(hours);
    const times = rows().map((r) => r.querySelector('.ph-tl-time')!.textContent!);
    expect([...times].sort().reverse().slice(0, 3)).toEqual(times.slice(0, 3));
  });

  it('keeps one chip per project and filters the list', async () => {
    await show(fakeApi().api);
    const all = rows().length;
    const chips = [...document.querySelectorAll('.ph-tl-chip')];
    expect(chips.map((c) => c.textContent)).toEqual(['All projects', 'pm-workspace', 'potato-site', 'notes']);
    await click(chips[3]);
    expect(rows()).toHaveLength(3);
    expect(rows().length).toBeLessThan(all);
  });

  it('says so when nothing changed today', async () => {
    const { api } = fakeApi();
    (api.day as ReturnType<typeof vi.fn>).mockResolvedValue({ ...sampleDay(), lanes: [] });
    await show(api);
    expect(document.body.textContent).toContain('Nothing has changed today.');
    expect(rows()).toHaveLength(0);
  });

  it('moves the handle to a tapped tick', async () => {
    await show(fakeApi().api);
    const ticks = [...document.querySelectorAll<HTMLButtonElement>('.ph-tl-tick')];
    await click(ticks[3]);
    expect(ticks[3].dataset.selected).toBe('true');
    expect(document.querySelectorAll('.ph-tl-tick[data-selected="true"]')).toHaveLength(1);
    expect(document.querySelectorAll('.ph-tl-row[aria-current="true"]')).toHaveLength(1);
  });
});

describe('phone Today: a point', () => {
  it('opens a sheet with the two counts and the file names, and shows one patch at a time, read only', async () => {
    const { api } = fakeApi();
    await show(api);
    await click(rows().find((r) => !r.dataset.faded && !r.textContent?.includes('went back'))!);
    expect(document.querySelector('[data-testid="phone-turn-count"]')?.textContent).toBe('This turn: 4 files');
    expect(document.querySelector('[data-testid="phone-back-count"]')?.textContent).toBe('Going back: 3 files change, 1 removed');
    expect(sheetText()).toContain('src-tauri/src/split.rs');
    await click(document.querySelector('.ph-tl-file'));
    expect(document.querySelector('.ph-tl-patch')?.textContent).toContain('useDrag');
    await click(document.querySelectorAll('.ph-tl-file')[1]);
    expect(document.querySelectorAll('.ph-tl-patch')).toHaveLength(1);
    expect(api.goBack).not.toHaveBeenCalled();
  });

  it('refuses in plain words while an agent works in the folder', async () => {
    const { api } = fakeApi();
    await show(api, [{ id: 'w', cwd: PM, name: 'Claude', status: 'running' }]);
    await click(rows().find((r) => r.querySelector('.ph-tl-project')?.textContent === 'pm-workspace' && !r.dataset.faded)!);
    expect(document.querySelector('.ph-tl-why')?.textContent).toBe('An agent is working in this project. Stop it or wait.');
    expect((button('Go back to here') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses a point that is too old', async () => {
    await show(fakeApi().api);
    await click(rows().find((r) => r.dataset.faded === 'true')!);
    expect(document.querySelector('.ph-tl-why')?.textContent).toBe('Too old to go back to.');
  });
});

describe('phone Today: go back', () => {
  it('asks in a second step with the project, time and counts, needs a hold, then shows "Went back" with Undo', async () => {
    vi.useFakeTimers();
    const { api, goBack } = fakeApi();
    await show(api);
    const row = rows().find((r) => r.querySelector('.ph-tl-project')?.textContent === 'pm-workspace' && !r.dataset.faded && r.querySelector('.ph-tl-back') === null)!;
    const time = row.querySelector('.ph-tl-time')!.textContent!;
    await click(row);
    await click(button('Go back to here'));
    const confirm = document.querySelector('[data-testid="phone-point"]')!.textContent!;
    expect(confirm).toContain(`Go back to ${time} in pm-workspace?`);
    expect(confirm).toContain('1 would change, 1 would come back, 1 would be removed');
    expect(confirm).toContain("This restores your files. It doesn't change what the agent remembers.");
    expect(goBack).toHaveLength(0);

    // A tap is not enough, and neither is a short press.
    const hold = document.querySelector<HTMLButtonElement>('.ph-hold')!;
    await act(async () => {
      hold.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      vi.advanceTimersByTime(HOLD_MS - 200);
      hold.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    expect(goBack).toHaveLength(0);
    // Held for the full time.
    await act(async () => {
      hold.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      vi.advanceTimersByTime(HOLD_MS + 50);
    });
    await act(async () => {});
    expect(goBack).toHaveLength(1);
    expect(goBack[0]).toMatchObject({ project: PM });
    const went = document.querySelector('[data-testid="phone-went"]')!;
    expect(went.textContent).toContain(`Went back to ${time}`);

    // Undo goes through the same call, to the safety copy in the `day` series.
    await click(went.querySelector('button'));
    expect(goBack[1]).toEqual({ project: PM, key: 'day', id: '9' });
    expect(document.querySelector('[data-testid="phone-went"]')!.textContent).toContain('Undone.');
  });

  it('cancel in the second step goes back to the point', async () => {
    const { api, goBack } = fakeApi();
    await show(api);
    await click(rows().find((r) => !r.dataset.faded && r.querySelector('.ph-tl-back') === null)!);
    await click(button('Go back to here'));
    await click(button('Cancel'));
    expect(button('Go back to here')).toBeTruthy();
    expect(goBack).toHaveLength(0);
  });
});

describe('phone: the menu entry and the bridge calls', () => {
  it('the menu shows Today only when the PC has the switch on', async () => {
    const menu = (on: (() => void) | undefined) =>
      root.render(<MenuSheet onClose={() => {}} bridgeUrl="http://x" bridgeReady settings={{} as never} onPatchSettings={() => {}} link={null} echo={null} activeLabel={null} onCloseActive={() => {}} onEditConnection={() => {}} onOpenToday={on} />);
    await act(async () => menu(undefined));
    expect(document.querySelector('[data-testid="phone-menu-today"]')).toBeNull();
    const open = vi.fn();
    await act(async () => menu(open));
    await click(document.querySelector('[data-testid="phone-menu-today"]'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('asks the PC for the day, a point and a go back, and reads a refusal as the PC\'s sentence', async () => {
    const calls: string[] = [];
    const bridge = {
      timelineDay: async (d: string) => (calls.push(`day ${d}`), sampleDay()),
      timelinePointDiff: async () => FIXTURE_TURN_FILES,
      timelineNowDiff: async () => sampleNowDiff(),
      timelinePatch: async (_p: PointRef, path: string, side: string) => (calls.push(`patch ${side} ${path}`), { patch: '', truncated: false }),
      timelineGoBack: async () => {
        throw new Error('bridge POST /timeline/point/restore -> 409: {"code":"PANE_RUNNING","error":"The agent is working. Interrupt it first, then undo."}');
      },
    } as unknown as BridgeClient;
    const api = bridgeTimelineApi(bridge);
    await api.day('2026-11-15');
    await api.filePatch({ project: PM, key: 'a', id: '1' }, 'a.txt', 'now');
    expect(calls).toEqual(['day 2026-11-15', 'patch now a.txt']);
    await expect(api.goBack({ project: PM, key: 'a', id: '1' })).rejects.toThrow('The agent is working. Interrupt it first, then undo.');
    await expect(bridgeTimelineApi({} as BridgeClient).day('2026-11-15')).rejects.toThrow('too old');
  });
});
