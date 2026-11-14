// @vitest-environment jsdom
// Screen-level: Open in my editor. The menu items of a file, the Settings row, Ctrl+Enter on a diff line, and the file tab's button.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMyEditor, pickEditor, setMyEditor, type EditorApi } from '../../lib/my-editor';
import type { FilesApi } from '../../lib/files-api';
import { MyEditorRow } from '../settings/blocks/MyEditorRow';
import { FileDiff, lineForRow } from './FileDiff';
import { FileTab } from './FileTab';
import { EditorMenuItems } from './OpenInEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const editorsOf = (...found: Array<[string, string]>): EditorApi => ({
  found: vi.fn(async () => found.map(([id, name]) => ({ id, name }))),
  open: vi.fn(async () => undefined),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  setMyEditor(null);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
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

describe('the editor choice', () => {
  it('uses the chosen editor when it is installed, else the first one found', () => {
    const list = [
      { id: 'vscode', name: 'VS Code' },
      { id: 'zed', name: 'Zed' },
    ];
    expect(pickEditor(list, 'zed')?.name).toBe('Zed');
    expect(pickEditor(list, 'gone')?.name).toBe('VS Code');
    expect(pickEditor([], 'zed')).toBeNull();
  });
});

describe('the menu items of a file', () => {
  it('with one editor installed: one item that opens the file in it', async () => {
    const api = editorsOf(['vscode', 'VS Code']);
    const onDone = vi.fn();
    await show(<EditorMenuItems paneId="p1" path="src/a.ts" onDone={onDone} onFail={vi.fn()} api={api} />);
    const items = [...host.querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Open in VS Code']);
    await act(async () => (items[0] as HTMLButtonElement).click());
    expect(api.open).toHaveBeenCalledWith('p1', 'src/a.ts', 'vscode');
    expect(onDone).toHaveBeenCalled();
  });

  it('with several installed and none chosen: one item each, and the pick becomes the person’s editor', async () => {
    const api = editorsOf(['vscode', 'VS Code'], ['zed', 'Zed']);
    await show(<EditorMenuItems paneId="p1" path="src/a.ts" onDone={vi.fn()} onFail={vi.fn()} api={api} />);
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['Open in VS Code', 'Open in Zed']);
    await act(async () => items[1].click());
    expect(api.open).toHaveBeenCalledWith('p1', 'src/a.ts', 'zed');
    expect(getMyEditor()).toBe('zed');
  });

  it('with none installed: a disabled item that says what to install', async () => {
    await show(<EditorMenuItems paneId="p1" path="src/a.ts" onDone={vi.fn()} onFail={vi.fn()} api={editorsOf()} />);
    const item = host.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe('No code editor found. Install VS Code or Cursor.');
  });

  it('when the editor cannot start, the person is told in plain words', async () => {
    const api = editorsOf(['vscode', 'VS Code']);
    api.open = vi.fn(async () => {
      throw new Error('EDITOR_START: Could not start the editor.');
    });
    const onFail = vi.fn();
    await show(<EditorMenuItems paneId="p1" path="src/a.ts" onDone={vi.fn()} onFail={onFail} api={api} />);
    await act(async () => host.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatch(/^Could not open the file\./);
  });
});

describe('Settings > General > My editor', () => {
  it('lists the editors found, saves the choice, and "First one found" forgets it', async () => {
    await show(<MyEditorRow api={editorsOf(['vscode', 'VS Code'], ['zed', 'Zed'])} />);
    const select = host.querySelector<HTMLSelectElement>('select')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['First one found', 'VS Code', 'Zed']);
    await act(async () => {
      select.value = 'zed';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getMyEditor()).toBe('zed');
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(getMyEditor()).toBeNull();
  });
});

describe('Ctrl+Enter on a diff line', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', '+three', ' four'].join('\n');

  it('maps a row to the line of the new file (a deleted row goes to the next line)', () => {
    expect(lineForRow([null, 1, null, 2, 3, 4], 1)).toBe(1);
    expect(lineForRow([null, 1, null, 2, 3, 4], 2)).toBe(2);
    expect(lineForRow([null, 1, null], 2)).toBe(1);
    expect(lineForRow([null], 0)).toBe(1);
  });

  it('opens the file at that line', async () => {
    const onOpenAt = vi.fn();
    await show(<FileDiff path="a.ts" patch={`diff --git a/a.ts b/a.ts
--- a/a.ts\n+++ b/a.ts\n${patch}\n`} canTell={false} onTell={() => undefined} onOpenAt={onOpenAt} />);
    const rows = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    await act(async () => {
      rows[4].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    expect(onOpenAt).toHaveBeenCalledWith(3);
  });

  it('does nothing without an editor callback, and a plain Enter still picks the line', async () => {
    await show(<FileDiff path="a.ts" patch={`diff --git a/a.ts b/a.ts
--- a/a.ts\n+++ b/a.ts\n${patch}\n`} canTell onTell={() => undefined} />);
    const rows = [...host.querySelectorAll<HTMLElement>('[role="option"]')];
    await act(async () => {
      rows[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(rows[2].getAttribute('aria-selected')).toBe('true');
  });
});

describe('the file tab', () => {
  const api = (text = 'one\ntwo\n'): FilesApi => ({
    list: vi.fn(async () => ({ entries: [], truncated: false })),
    read: vi.fn(async (_p, path) => ({ path, name: 'a.txt', size: text.length, kind: 'binary' as const })),
    marks: vi.fn(async () => []),
    reveal: vi.fn(async () => undefined),
    diff: vi.fn(async () => ''),
  });

  it('has an Open in editor button, and Ctrl+Enter does the same', async () => {
    const editor = editorsOf(['cursor', 'Cursor']);
    await show(<FileTab paneId="p1" path="src/a.txt" canTell={false} api={api()} editor={editor} />);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open in Cursor')!;
    await act(async () => button.click());
    expect(editor.open).toHaveBeenCalledWith('p1', 'src/a.txt', 'cursor', undefined);
    await act(async () => {
      host.querySelector('[data-testid="file-tab"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });
    expect(editor.open).toHaveBeenCalledTimes(2);
  });
});
