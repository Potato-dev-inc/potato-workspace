// @vitest-environment jsdom
// The Today page as a person meets it: the line with its lanes and marks, picking a point, the two columns,
// "Go back to here" with its sheet, toast and Undo, the plain-words refusals, and the keyboard.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_NOW, FIXTURE_TURN_FILES, PM, SAMPLE_PATCH, row, sampleDay, sampleNowDiff } from '../../dev/timeline-fixtures';
import type { GoBackReport, NowDiff, PointRef, TimelineApi, TimelineDay } from '../../lib/timeline';
import type { ToastAction } from '../cockpit/restore-flow';
import { TodayPage } from './TodayPage';
import type { PaneLite } from './refusal';

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
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

interface Rig {
  api: TimelineApi;
  state: { day: TimelineDay; back: NowDiff | Error };
  calls: { goBack: PointRef[]; nowDiff: PointRef[]; pointDiff: PointRef[]; patch: { ref: PointRef; path: string; side?: string }[] };
  notes: { text: string; action?: ToastAction }[];
}

function rig(over: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = { day: sampleDay(), back: sampleNowDiff(), ...over };
  const calls: Rig['calls'] = { goBack: [], nowDiff: [], pointDiff: [], patch: [] };
  const api: TimelineApi = {
    day: vi.fn(async () => state.day),
    pointDiff: vi.fn(async (p) => {
      calls.pointDiff.push(p);
      return FIXTURE_TURN_FILES;
    }),
    nowDiff: vi.fn(async (p) => {
      calls.nowDiff.push(p);
      if (state.back instanceof Error) throw state.back;
      return state.back;
    }),
    filePatch: vi.fn(async (p, path, side) => {
      calls.patch.push({ ref: p, path, side });
      return { patch: SAMPLE_PATCH, truncated: false };
    }),
    goBack: vi.fn(async (p) => {
      calls.goBack.push(p);
      const report: GoBackReport = { safetyId: '9', written: 3, removed: 1, failed: [] };
      // The go back is itself a mark on the line, at "now".
      const lanes = state.day.lanes.map((l) =>
        l.project === PM ? { ...l, rows: [...l.rows, row({ project: PM, key: 'day', id: String(calls.goBack.length), atMs: FIXTURE_NOW, kind: 'undo', agentType: '', files: 3 })] } : l,
      );
      state.day = { ...state.day, lanes };
      return report;
    }),
  };
  return { api, state, calls, notes: [] };
}

async function show(r: Rig, props: { panes?: PaneLite[]; simple?: boolean } = {}) {
  await act(async () => {
    root.render(<TodayPage api={r.api} onClose={() => {}} notify={(text, action) => r.notes.push({ text, action })} now={() => FIXTURE_NOW} refreshMs={0} {...props} />);
  });
  await act(async () => {});
  await act(async () => {});
}

const marks = () => [...host.querySelectorAll<HTMLButtonElement>('.ck-tl-mark')];
const laneNames = () => [...host.querySelectorAll('.ck-tl-name-text')].map((n) => n.textContent);
const goBack = () => host.querySelector<HTMLButtonElement>('[data-testid="timeline-go-back"]')!;
const why = () => host.querySelector('.ck-tl-why')?.textContent ?? null;
const sheet = () => document.querySelector('.ck-sheet');
const text = () => host.textContent ?? '';

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await act(async () => {});
}

describe('Today page: the line', () => {
  it('shows a lane per project (a worktree sits in its parent), the newest activity first, with a mark for each turn', async () => {
    await show(rig());
    expect(laneNames()).toEqual(['pm-workspace', 'potato-site', 'notes']);
    // A busy stretch is one pill; every other turn has its own mark.
    expect(marks().length).toBeGreaterThan(80);
    expect(marks().filter((m) => m.dataset.faded === 'true')).toHaveLength(10);
    expect(marks().filter((m) => m.dataset.shape === 'undo')).toHaveLength(1);
    expect(marks().filter((m) => m.dataset.branch === 'true')).toHaveLength(4);
    expect(host.querySelectorAll('.ck-tl-fold').length).toBeGreaterThanOrEqual(1);
    expect(host.querySelector('h1')?.textContent).toBe('Today');
    // Every mark is labelled for a screen reader: time, project, agent, turn, files.
    expect(marks().every((m) => /^\d\d:\d\d, /.test(m.getAttribute('aria-label') ?? ''))).toBe(true);
  });

  it('hides a mission step until "Show helpers\' own steps" is on', async () => {
    await show(rig());
    const before = marks().length;
    await click([...host.querySelectorAll('label')].find((l) => l.textContent?.includes("helpers' own steps"))!.querySelector('input'));
    expect(marks().length).toBe(before + 1);
  });

  it('says so in plain words when nothing has changed today', async () => {
    const r = rig();
    r.state.day = { ...r.state.day, lanes: [] };
    await show(r);
    expect(host.querySelector('[data-testid="timeline-empty"]')?.textContent).toBe('Nothing has changed today. When an agent changes files, the points show up here.');
    expect(marks()).toHaveLength(0);
  });

  it('opens a busy stretch from its pill', async () => {
    await show(rig());
    const pill = host.querySelector<HTMLButtonElement>('.ck-tl-cluster');
    expect(pill).not.toBeNull();
    const count = Number(pill!.textContent);
    expect(count).toBeGreaterThan(6);
    await click(pill);
    expect(host.querySelector('.ck-tl-cluster')).toBeNull();
    expect(marks().length).toBeGreaterThanOrEqual(count);
  });

  it('zooms to one hour and back to the whole day', async () => {
    await show(rig());
    const all = marks().length;
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '1 hour')!);
    expect(marks().length).toBeLessThan(all);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Whole day')!);
    expect(marks().length).toBeGreaterThanOrEqual(all - 10);
  });
});

describe('Today page: a picked point', () => {
  it('fills both columns: what the turn changed and what going back would change', async () => {
    const r = rig();
    await show(r);
    const mark = marks().find((m) => m.dataset.faded !== 'true' && m.dataset.shape === 'turn')!;
    await click(mark);
    const last = r.calls.pointDiff.at(-1)!;
    expect(mark.dataset.markId).toBe(`${last.project}|${last.key}|${last.id}`);
    expect(r.calls.nowDiff.at(-1)).toEqual(last);
    const detail = host.querySelector('[data-testid="timeline-detail"]')!;
    expect(detail.textContent).toContain('What changed in this turn');
    expect(detail.textContent).toContain('What going back to here would change');
    expect(detail.textContent).toContain('src-tauri/src/split.rs');
    expect(host.querySelector('[data-testid="timeline-sum"]')?.textContent).toBe('1 would change, 1 would come back, 1 would be removed');
    expect(mark.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a file\'s patch when it is clicked, read only', async () => {
    const r = rig();
    await show(r);
    await click(marks().find((m) => m.dataset.faded !== 'true' && m.dataset.shape === 'turn')!);
    await click([...host.querySelectorAll('.ck-tl-file-btn')].find((b) => b.textContent?.includes('SplitView.tsx'))!);
    expect(r.calls.patch.at(-1)).toMatchObject({ path: 'src/components/SplitView.tsx', side: 'turn' });
    expect(host.querySelector('.ck-tl-patch')?.textContent).toContain('useDrag');
    // The right column asks for the other side.
    const right = host.querySelectorAll('.ck-tl-col')[1];
    await click([...right.querySelectorAll('.ck-tl-file-btn')].find((b) => b.textContent?.includes('SplitView.tsx'))!);
    expect(r.calls.patch.at(-1)).toMatchObject({ side: 'now' });
  });

  it('says which go back this was when the point is a go back', async () => {
    await show(rig());
    await click(marks().find((m) => m.dataset.shape === 'undo')!);
    expect(text()).toContain('You went back here');
  });
});

describe('Today page: Go back to here', () => {
  it('asks first (project, time, counts, memory sentence, git note), then goes back with a toast whose Undo restores the safety point, and a back-arrow mark appears', async () => {
    const r = rig();
    await show(r);
    const mark = marks().find((m) => m.dataset.faded !== 'true' && m.dataset.shape === 'turn' && m.dataset.branch !== 'true')!;
    await click(mark);
    expect(goBack().disabled).toBe(false);
    await click(goBack());
    const s = sheet()!;
    expect(s.textContent).toContain('pm-workspace');
    expect(s.textContent).toMatch(/Go back to \d\d:\d\d in pm-workspace\?/);
    expect(s.textContent).toContain('1 would change, 1 would come back, 1 would be removed');
    expect(s.textContent).toContain("This restores your files. It doesn't change what the agent remembers.");
    expect(s.textContent).toContain('Your git history is not changed.');
    expect(r.calls.goBack).toHaveLength(0);

    const arrows = marks().filter((m) => m.dataset.shape === 'undo').length;
    await click([...s.querySelectorAll('button')].find((b) => b.textContent === 'Go back')!);
    expect(r.calls.goBack).toHaveLength(1);
    expect(r.calls.goBack[0]).toEqual({ project: PM, key: mark.dataset.markId!.split('|')[1], id: mark.dataset.markId!.split('|')[2] });
    expect(sheet()).toBeNull();
    expect(r.notes.at(-1)!.text).toMatch(/^Went back to \d\d:\d\d in pm-workspace\.$/);
    expect(r.notes.at(-1)!.action?.label).toBe('Undo');
    expect(marks().filter((m) => m.dataset.shape === 'undo')).toHaveLength(arrows + 1);

    // Undo goes through the same call, at the `day` series' safety point.
    await act(async () => r.notes.at(-1)!.action!.run());
    await act(async () => {});
    expect(r.calls.goBack.at(-1)).toEqual({ project: PM, key: 'day', id: '9' });
    expect(r.notes.at(-1)!.text).toBe('Undone. Your files are back as they were.');
  });

  it('names the other chats that share the folder', async () => {
    await show(rig(), { panes: [{ id: 'x', cwd: PM, name: 'Codex', status: 'idle' }] });
    await click(marks().find((m) => m.dataset.faded !== 'true' && m.dataset.shape === 'turn' && m.dataset.branch !== 'true')!);
    await click(goBack());
    expect(sheet()!.textContent).toContain('Codex also works in this folder.');
  });

  it('cancelling changes nothing', async () => {
    const r = rig();
    await show(r);
    await click(goBack());
    await click([...sheet()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!);
    expect(sheet()).toBeNull();
    expect(r.calls.goBack).toHaveLength(0);
  });

  it('uses the "went back" wording in Simple mode, without turn numbers or line counts', async () => {
    const r = rig();
    await show(r, { simple: true });
    expect(host.querySelector('h1')?.textContent).toBe('Your day');
    const detail = host.querySelector('[data-testid="timeline-detail"]')!;
    expect(detail.textContent).not.toMatch(/turn \d|\+\d+ −\d+/);
    expect(goBack().textContent).toBe('Go back to this time');
    await click(goBack());
    expect(sheet()!.textContent).toMatch(/Go back to \d\d:\d\d\?/);
    await click([...sheet()!.querySelectorAll('button')].find((b) => b.textContent === 'Go back')!);
    expect(r.notes.at(-1)!.text).toMatch(/^Went back to \d\d:\d\d\.$/);
  });
});

describe('Today page: when going back is refused', () => {
  it('disables the button with the reason beside it, and nothing is sent', async () => {
    const r = rig();
    await show(r, { panes: [{ id: 'w', cwd: PM, name: 'Claude', status: 'running' }] });
    expect(goBack().disabled).toBe(true);
    expect(why()).toBe('An agent is working in this project. Stop it or wait.');
    await click(goBack());
    expect(sheet()).toBeNull();
    expect(r.calls.goBack).toHaveLength(0);
  });

  it('a chat working in a worktree inside the project counts too', async () => {
    await show(rig(), { panes: [{ id: 'w', cwd: `${PM}/.worktrees/x`, name: 'Gemini', status: 'running' }] });
    expect(why()).toBe('An agent is working in this project. Stop it or wait.');
  });

  it('a chat in another folder does not', async () => {
    await show(rig(), { panes: [{ id: 'w', cwd: 'C:/elsewhere', name: 'Gemini', status: 'running' }] });
    expect(goBack().disabled).toBe(false);
    expect(why()).toBeNull();
  });

  it('says a pruned point is too old', async () => {
    await show(rig());
    await click(marks().find((m) => m.dataset.faded === 'true')!);
    expect(goBack().disabled).toBe(true);
    expect(why()).toBe('Too old to go back to.');
  });

  it.each([
    ['Undo is off for this folder: it is too big. Add big folders to .gitignore.', 'Undo is off for this folder: it is too big.'],
    ['Checkpoints are turned off in Settings.', 'Checkpoints are off in Settings.'],
    ['The folder is gone.', 'The folder is gone.'],
    ['A run is still open on this pane. Interrupt it first, then undo.', 'A run is still open in this project. Stop it or wait.'],
  ])('turns the backend sentence "%s" into plain words', async (said, plain) => {
    await show(rig({ back: new Error(said) }));
    expect(goBack().disabled).toBe(true);
    expect(why()).toBe(plain);
  });

  it('draws a whole lane as gone when its folder is gone', async () => {
    const r = rig();
    r.state.day = { ...r.state.day, lanes: r.state.day.lanes.map((l) => (l.project === PM ? { ...l, folderGone: true, rows: l.rows.map((x) => ({ ...x, gone: true })) } : l)) };
    await show(r);
    await click(marks().find((m) => m.dataset.markId?.startsWith(`${PM}|`))!);
    expect(why()).toBe('The folder is gone.');
    expect(goBack().disabled).toBe(true);
  });
});

describe('Today page: the keyboard', () => {
  it('reaches a mark, opens the sheet, cancels, and focus comes back to the mark', async () => {
    const r = rig();
    await show(r);
    const stops = marks().filter((m) => m.tabIndex === 0);
    expect(stops).toHaveLength(1);
    const selected = stops[0];
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    selected.focus();
    expect(document.activeElement).toBe(selected);
    await act(async () => goBack().click());
    expect(sheet()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(selected);
    expect(r.calls.goBack).toHaveLength(0);
  });

  it('walks the marks with the arrow keys and moves focus with the selection', async () => {
    await show(rig());
    const line = host.querySelector('.ck-tl')!;
    const before = marks().find((m) => m.tabIndex === 0)!;
    before.focus();
    await act(async () => {
      before.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    });
    await act(async () => {});
    const after = marks().find((m) => m.getAttribute('aria-pressed') === 'true')!;
    expect(after).not.toBe(before);
    expect(after.dataset.markId).not.toBe(before.dataset.markId);
    expect(document.activeElement).toBe(after);
    expect(line).not.toBeNull();
  });
});

describe('Today page: other days', () => {
  it('asks for the day before and shows its title', async () => {
    const r = rig();
    await show(r);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Earlier day'))!);
    expect((r.api.day as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toBe('2026-11-14');
    expect(host.querySelector('h1')?.textContent).not.toBe('Today');
  });
});
