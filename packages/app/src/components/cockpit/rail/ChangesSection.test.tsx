// @vitest-environment jsdom
// Screen-level: the right-panel Changes section: the totals row, the most changed files, line-endings-only files left out of
// the totals, and the one line of buttons. Wiring checks (the pieces are mounted by their parent screens) are at the bottom.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDecision, putBackMark, resetReviewMarks, stateOf } from '../../../lib/turn-review';
import { useEnglish } from '../../../i18n/test-utils';
import { resetRailFoldForTests } from './railFold';
import { SETTLE_WAITS } from '../../../lib/turn-review';
import { changeRows, changeTotals, ChangesSection, topChanges } from './ChangesSection';
import { OutputsSection } from './OutputsSection';

const REVIEW = {
  turn: 2,
  beforeId: '3',
  afterId: '4',
  truncated: false,
  files: [
    { path: 'src/a.ts', status: 'M', added: 212, deleted: 340, binary: false, blob: 'ba' },
    { path: 'src/b.css', status: 'M', added: 188, deleted: 231, binary: false, blob: 'bb' },
    { path: 'src/c.tsx', status: 'A', added: 96, deleted: 0, binary: false, blob: 'bc' },
    { path: 'package-lock.json', status: 'M', added: 11357, deleted: 11357, binary: false, blob: 'bd', lineEndingsOnly: true },
  ],
};
let review: typeof REVIEW | null = REVIEW;
const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoint_turn_review' ? review : null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outputs = ['a', 'b', 'c'].map((n) => ({ path: `C:/proj/src/${n}.ts`, tool: 'Edit', wrote: true as const }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetReviewMarks();
  review = REVIEW;
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = async (props: { open?: () => void; pr?: boolean; outs?: typeof outputs } = {}) => {
  await act(async () => root.render(<ChangesSection paneId="p1" status="idle" cwd="C:/proj" outputs={props.outs ?? outputs} canCreatePr={!!props.pr} showDone={false} onOpenChanges={props.open} />));
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
};
const reviewReads = () => invoke.mock.calls.filter(([cmd]) => cmd === 'checkpoint_turn_review').length;
const total = () => host.querySelector('[data-testid="rail-changes-total"]')!.textContent;

describe('Changes section numbers', () => {
  it('counts every file but leaves a line-endings-only file out of the +/- totals', () => {
    const rows = changeRows(REVIEW.files, []);
    expect(changeTotals(rows)).toEqual({ files: 4, added: 496, deleted: 571 });
  });
  it('lists the most changed files first and the line-endings-only one last', () => {
    expect(topChanges(changeRows(REVIEW.files, [])).map((r) => r.path)).toEqual(['src/a.ts', 'src/b.css', 'src/c.tsx', 'package-lock.json']);
  });
  it('without a review it falls back to the written files, with no numbers', () => {
    expect(changeRows([], outputs).map((r) => [r.added, r.deleted])).toEqual([[0, 0], [0, 0], [0, 0]]);
  });
});

describe('Changes section on screen', () => {
  it('shows the totals row, status letters and "line endings only"', async () => {
    await show({ open: () => {} });
    expect(total()).toBe('4 files+496 −571');
    const text = host.textContent ?? '';
    expect(text).toContain('line endings only');
    expect(text).not.toContain('11,357');
    expect(host.querySelectorAll('.rp-mk').length).toBe(4);
  });
  it('shows the one line of buttons: Review, Keep all, and Create PR only when a pull request can be made', async () => {
    const open = vi.fn();
    await show({ open });
    const names = () => [...host.querySelectorAll('.rp-acts button')].map((b) => b.textContent);
    expect(names()).toEqual(['Review', 'Keep all']);
    await show({ open, pr: true });
    expect(names()).toEqual(['Review', 'Keep all', 'Create PR']);
    await act(async () => host.querySelector<HTMLButtonElement>('.rp-btn-pri')!.click());
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('Keep all keeps every file of the review', async () => {
    await show({ open: () => {} });
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.rp-acts button')].find((b) => b.textContent === 'Keep all')!.click());
    expect(stateOf('p1', REVIEW.files[0]).decision).toBe('kept');
    expect(stateOf('p1', REVIEW.files[3]).decision).toBe('kept');
  });
  it('says "No changes yet" and has no buttons when nothing changed', async () => {
    review = null;
    await show({ outs: [] });
    expect(host.textContent).toContain('No changes yet');
    expect(host.querySelector('.rp-acts')).toBeNull();
  });
  it('folded, it shows the coloured totals at the right of the label', async () => {
    window.localStorage.setItem('pm.rail.closed', 'chg');
    resetRailFoldForTests();
    await show();
    expect(host.querySelector('.rp-rows')).toBeNull();
    expect(host.querySelector('.rp-sum')!.textContent).toBe('+496 −571');
  });
});

describe('a second turn', () => {
  const render = (turnKey: string) => act(async () => root.render(<ChangesSection paneId="p1" status="idle" turnKey={turnKey} cwd="C:/proj" outputs={outputs} canCreatePr={false} showDone={false} />));
  it('reads the review again when the turns change even though the status did not (a far chat samples its status)', async () => {
    review = { ...REVIEW, files: REVIEW.files.slice(0, 1) };
    await render('1:t1:11:1');
    await act(async () => void (await new Promise((r) => setImmediate(r))));
    expect(host.querySelector('[data-testid="rail-changes-total"]')!.textContent).toContain('1 file');
    const reads = reviewReads();
    review = { ...REVIEW, files: REVIEW.files.slice(0, 2) };
    await render('2:t2:11:2');
    await act(async () => void (await new Promise((r) => setImmediate(r))));
    expect(reviewReads()).toBe(reads + 1);
    expect(host.querySelector('[data-testid="rail-changes-total"]')!.textContent).toContain('2 files');
  });
  it('reads again until the turn that just closed has its review (a far host writes the end save point late)', async () => {
    const waits = SETTLE_WAITS.splice(0, SETTLE_WAITS.length, 5, 5, 5);
    try {
      review = { ...REVIEW, afterId: '4', files: REVIEW.files.slice(0, 1) };
      await render('1:t1:11:1');
      await act(async () => void (await new Promise((r) => setImmediate(r))));
      // The turn closes, but the host still answers with the old review.
      await render('2:t2:11:2');
      await act(async () => void (await new Promise((r) => setTimeout(r, 2))));
      expect(host.querySelector('[data-testid="rail-changes-total"]')!.textContent).toContain('1 file');
      // The host writes the new save point later; nothing in the chat changes, the retry finds it.
      review = { ...REVIEW, afterId: '6', files: REVIEW.files.slice(0, 2) };
      await act(async () => void (await new Promise((r) => setTimeout(r, 40))));
      expect(host.querySelector('[data-testid="rail-changes-total"]')!.textContent).toContain('2 files');
    } finally {
      SETTLE_WAITS.splice(0, SETTLE_WAITS.length, ...waits);
    }
  });
  it('does not read again when nothing changed', async () => {
    await render('1:t1:11:1');
    await act(async () => void (await new Promise((r) => setImmediate(r))));
    const reads = reviewReads();
    await render('1:t1:11:1');
    expect(reviewReads()).toBe(reads);
  });
});

describe('the pieces are mounted by their parent screens', () => {
  const src = (file: string) => readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');
  it('the pane shows the review, no result strip, and opens the right tab from the rail', () => {
    const pane = src('components/cockpit/PaneView.tsx');
    expect(pane).toContain('<TurnFiles paneId={paneId}');
    expect(pane).toContain('turnReview={<TurnFiles');
    expect(pane).not.toContain('AcpResultStrip');
    expect(pane).not.toContain('<DoneList');
    expect(pane).toContain("onOpenChanges={worktree ? () => setTab('changes') : () => setTab('receipt')}");
    expect(src('components/cockpit/rail/SessionRail.tsx')).toContain('<ChangesSection paneId={paneId} status={status}');
  });
  it('Open in editor is offered on a file in the Files card, Changes, chat chips, the file tab and Settings', () => {
    for (const file of ['components/files/FilesCard.tsx', 'components/cockpit/Changes.tsx', 'components/chat/ToolDetail.tsx']) {
      expect(src(file), file).toContain('<EditorMenuItems');
    }
    expect(src('components/files/FileTab.tsx')).toContain('useOpenInEditor');
    expect(src('components/settings/sections/GeneralSection.tsx')).toContain('<MyEditorRow');
    expect(src('components/chat/SessionChatPanel.tsx')).toContain('ChatPaneContext.Provider');
  });
});

describe('a file the person put back', () => {

  it('leaves Changes and the totals, and comes back with its Undo', async () => {
    await show();
    expect(total()).toBe('4 files+496 −571');
    await act(async () => putBackMark('p1', REVIEW.files[2]!, 'safe-1'));
    expect(total()).toBe('3 files+400 −571');
    expect(host.textContent).not.toContain('c.tsx');
    await act(async () => clearDecision('p1', 'src/c.tsx'));
    expect(total()).toBe('4 files+496 −571');
  });
  it('leaves Outputs, which the chat events alone would still list', async () => {
    await act(async () => root.render(<OutputsSection paneId="p1" cwd="C:/proj" outputs={[{ path: 'C:/proj/notes.md', tool: 'Write', wrote: true }]} />));
    expect(host.textContent).toContain('notes.md');
    await act(async () => putBackMark('p1', { path: 'notes.md', status: 'A', added: 1, deleted: 0, binary: false, blob: 'x' }, 's'));
    expect(host.textContent).not.toContain('notes.md');
  });
});
