// @vitest-environment jsdom
// Screen-level: the right-panel Changes card shares the review: the counter, a state word on each file, and a link to
// review the files one by one. Wiring checks (the pieces are mounted by their parent screens) are at the bottom.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepFile, lookedAt, putBackMark, resetReviewMarks } from '../../../lib/turn-review';
import { ChangesCard } from './ChangesCard';

const REVIEW = {
  turn: 2,
  beforeId: '3',
  afterId: '4',
  truncated: false,
  files: [
    { path: 'src/a.ts', status: 'M', added: 1, deleted: 0, binary: false, blob: 'ba' },
    { path: 'src/b.ts', status: 'M', added: 1, deleted: 0, binary: false, blob: 'bb' },
    { path: 'src/c.ts', status: 'A', added: 1, deleted: 0, binary: false, blob: 'bc' },
  ],
};
const invoke = vi.fn(async (cmd: string) => (cmd === 'checkpoint_turn_review' ? REVIEW : null));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...(a as [string])) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outputs = ['a', 'b', 'c'].map((n) => ({ path: `C:/proj/src/${n}.ts`, tool: 'Edit', wrote: true as const }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetReviewMarks();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = async (open?: () => void) => {
  await act(async () => root.render(<ChangesCard paneId="p1" status="idle" outputs={outputs} cwd="C:/proj" onOpenChanges={open} />));
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
};

describe('Changes card and the review', () => {
  it('says where the review stands, and names the state of each file', async () => {
    await show();
    expect(host.querySelector('[data-testid="rail-review-line"]')!.textContent).toBe('3 left · 0 of 3 looked at');
    const file = (n: string) => ({ path: `src/${n}.ts`, status: 'M', added: 1, deleted: 0, binary: false, blob: `b${n}` });
    await act(async () => {
      keepFile('p1', file('a'));
      putBackMark('p1', file('b'), '9');
      lookedAt('p1', file('a'));
    });
    expect(host.querySelector('[data-testid="rail-review-line"]')!.textContent).toBe('1 kept · 1 put back · 1 left · 1 of 3 looked at');
    const items = [...host.querySelectorAll('.ck-rail-item')].map((i) => i.textContent);
    expect(items.some((t) => t?.includes('a.ts') && t.includes('Kept'))).toBe(true);
    expect(items.some((t) => t?.includes('b.ts') && t.includes('Put back'))).toBe(true);
  });

  it('has a link that opens the tab where the files are reviewed', async () => {
    const open = vi.fn();
    await show(open);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="rail-review-open"]')!.click());
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('the pieces are mounted by their parent screens', () => {
  const src = (file: string) => readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');
  it('the pane shows the review (Receipt tab, or Changes for a separate copy), the Done list, and opens the right tab from the rail', () => {
    const pane = src('components/cockpit/PaneView.tsx');
    expect(pane).toContain('<TurnFiles paneId={paneId}');
    expect(pane).toContain('turnReview={<TurnFiles');
    expect(pane).toContain('<DoneList paneId={paneId} cwd={info.cwd} />');
    expect(pane).toContain("onOpenChanges={worktree ? () => setTab('changes') : () => setTab('receipt')}");
    expect(src('components/cockpit/rail/SessionRail.tsx')).toContain('<ChangesCard paneId={paneId} status={status}');
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
