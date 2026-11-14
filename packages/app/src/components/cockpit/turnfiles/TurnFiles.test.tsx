// @vitest-environment jsdom
// Screen-level: review the last turn file by file. Keep and Put back per file, J / K / A / X / T / V keys, the counters,
// the undo bar after a put back, "looked at" ticks and "Changed since you looked".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeComposerInserts, resetComposerInserts } from '../../../lib/composer-insert';
import type { EditorApi } from '../../../lib/my-editor';
import { resetReviewMarks, type ReviewFile, type TurnReviewApi, type TurnReviewData } from '../../../lib/turn-review';
import { currentUndo, resetUndoBar, runUndo } from '../../../lib/undo-bar';
import { TurnFiles } from './TurnFiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const file = (path: string, over: Partial<ReviewFile> = {}): ReviewFile => ({ path, status: 'M', added: 3, deleted: 1, binary: false, blob: `blob-${path}`, ...over });
const review = (files: ReviewFile[], afterId = '4'): TurnReviewData => ({ turn: 2, beforeId: '3', afterId, files, truncated: false });
const PATCH = ['@@ -1,2 +1,3 @@', ' keep', '-old', '+new', '+newer'].join('\n');

function fakes(data: TurnReviewData | null = review([file('src/a.ts'), file('src/b.ts'), file('docs/c.md', { status: 'A' })])) {
  const api: TurnReviewApi = {
    review: vi.fn(async () => data),
    patch: vi.fn(async () => `diff --git a/x b/x\n--- a/x\n+++ b/x\n${PATCH}\n`),
    putBack: vi.fn(async () => ({ safetyId: '9', action: 'written' })),
  };
  const editor: EditorApi = { found: vi.fn(async () => [{ id: 'vscode', name: 'VS Code' }]), open: vi.fn(async () => undefined) };
  return { api, editor };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  resetReviewMarks();
  resetUndoBar();
  resetComposerInserts();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const show = async (node: React.ReactNode) => {
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
};
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="turn-file"]')];
const counter = () => host.querySelector('[data-testid="turn-files-counter"]')!.textContent;
const looked = () => host.querySelector('[data-testid="turn-files-looked"]')!.textContent;
const button = (row: HTMLElement, label: string) => [...row.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const press = async (key: string) => {
  const target = host.querySelector<HTMLElement>('[data-tf-row][tabindex="0"]')!;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

describe('Review the last turn', () => {
  it('lists every file the turn changed with Keep and Put back, and starts with all of them left', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    expect(rows()).toHaveLength(3);
    expect(rows().map((r) => r.querySelector('.ck-tf-name')!.textContent)).toEqual(['a.ts', 'b.ts', 'c.md']);
    expect(rows().every((r) => button(r, 'Keep') && button(r, 'Put back'))).toBe(true);
    expect(counter()).toBe('3 left');
    expect(looked()).toBe('0 of 3 looked at');
  });

  it('says so when the turn changed nothing, and shows the reason when save points are off', async () => {
    const { api, editor } = fakes(null);
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    expect(host.textContent).toContain('The last turn changed no files.');
    api.review = vi.fn(async () => {
      throw new Error('Checkpoints are turned off in Settings.');
    });
    await show(<TurnFiles paneId="p2" status="idle" api={api} editor={editor} />);
    expect(host.textContent).toContain('Checkpoints are turned off in Settings.');
  });

  it('Keep marks one file and the counter follows: "1 kept · 2 left"', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => button(rows()[0], 'Keep').click());
    expect(counter()).toBe('1 kept · 2 left');
    expect(rows()[0].dataset.decision).toBe('kept');
    expect(rows()[1].dataset.decision).toBe('left');
  });

  it('Put back returns only that file, shows the undo bar, and Undo brings the agent’s version back from the safety save point', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => button(rows()[1], 'Put back').click());
    expect(api.putBack).toHaveBeenCalledTimes(1);
    expect(api.putBack).toHaveBeenCalledWith('p1', '3', 'src/b.ts');
    expect(counter()).toBe('1 put back · 2 left');
    expect(rows()[1].dataset.decision).toBe('back');
    expect(currentUndo()?.text).toBe('Put back b.ts');
    await act(async () => {
      runUndo();
    });
    expect(api.putBack).toHaveBeenLastCalledWith('p1', '9', 'src/b.ts');
    expect(counter()).toBe('3 left');
  });

  it('says plainly when Put back could not be done, and changes nothing', async () => {
    const { api, editor } = fakes();
    api.putBack = vi.fn(async () => {
      throw new Error('That file is outside the project folder.');
    });
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => button(rows()[0], 'Put back').click());
    expect(host.textContent).toContain('Could not put back a.ts. That file is outside the project folder.');
    expect(counter()).toBe('3 left');
    expect(currentUndo()).toBeNull();
  });

  it('while the agent works, Put back is off with a plain reason', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="running" api={api} editor={editor} />);
    const b = button(rows()[0], 'Put back');
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('The agent is working. You can put a file back when it stops.');
  });

  it('J and K move between files, A keeps and moves on, X puts back and moves on, "6 kept · 1 put back · 2 left" style counter', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await press('a'); // keeps a.ts, now on b.ts
    await press('x'); // puts b.ts back, now on c.md
    expect(api.putBack).toHaveBeenCalledWith('p1', '3', 'src/b.ts');
    expect(counter()).toBe('1 kept · 1 put back · 1 left');
    await press('k');
    expect(host.querySelector<HTMLElement>('[data-tf-row][tabindex="0"]')!.dataset.tfRow).toBe('src/b.ts');
    await press('j');
    expect(host.querySelector<HTMLElement>('[data-tf-row][tabindex="0"]')!.dataset.tfRow).toBe('docs/c.md');
  });

  it('T writes about the file in the message box and sends nothing', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await press('t');
    expect(takeComposerInserts('p1')).toBe('About `src/a.ts`: ');
  });

  it('opening a file shows its diff; a diff that fits counts as looked at, and V marks one too', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => rows()[0].querySelector<HTMLButtonElement>('.ck-tf-main')!.click());
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
    expect(api.patch).toHaveBeenCalledWith('p1', '3', '4', 'src/a.ts');
    expect(host.querySelector('[data-testid="file-diff"]')).not.toBeNull();
    expect(looked()).toBe('1 of 3 looked at');
    await press('j');
    await press('v');
    expect(looked()).toBe('2 of 3 looked at');
  });

  it('a later edit to a file you looked at shows "Changed since you looked"', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await press('v');
    expect(rows()[0].dataset.look).toBe('looked');
    // The agent edits a.ts again in a later turn: the same path, a new content id.
    api.review = vi.fn(async () => review([file('src/a.ts', { blob: 'blob-a-v2' })], '7'));
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await show(<TurnFiles paneId="p1" status="running" api={api} editor={editor} />);
    expect(rows()[0].dataset.look).toBe('changed');
    expect(rows()[0].textContent).toContain('Changed since you looked');
    expect(looked()).toBe('0 of 1 looked at');
  });

  it('a Keep belongs to one version: after another edit the file is left again', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => button(rows()[0], 'Keep').click());
    expect(counter()).toBe('1 kept · 2 left');
    api.review = vi.fn(async () => review([file('src/a.ts', { blob: 'blob-a-v2' })], '7'));
    await show(<TurnFiles paneId="p1" status="running" api={api} editor={editor} />);
    expect(counter()).toBe('1 left');
  });

  it('Open in editor opens the file in the chosen editor, and a missing editor says so', async () => {
    const { api, editor } = fakes();
    await show(<TurnFiles paneId="p1" status="idle" api={api} editor={editor} />);
    await act(async () => button(rows()[0], 'Open in VS Code').click());
    expect(editor.open).toHaveBeenCalledWith('p1', 'src/a.ts', 'vscode', undefined);
    const none = fakes();
    none.editor.found = vi.fn(async () => []);
    await show(<TurnFiles paneId="p3" status="idle" api={none.api} editor={none.editor} />);
    expect(button(rows()[0], 'Open in editor').disabled).toBe(true);
  });
});
