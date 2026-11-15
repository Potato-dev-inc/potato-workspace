// @vitest-environment jsdom
// Editing a file in its tab (the real CodeMirror editor): Edit, type, the unsaved dot, Save / Ctrl+S, Revert, and the
// "changed on disk" bar with Reload and Keep mine.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { FileTab } from './FileTab';
import { FileTabsBar } from './FileTabsBar';
import { fakeApi } from './fakes';
import { normalise, toDisk } from './useFileEdit';
import type { FileContent, FilesApi } from '../../lib/files-api';
import { resetFileDrafts } from '../../lib/file-drafts';
import { resetFileTabs, openFileTab } from '../../lib/file-tabs';
import { useEnglish } from '../../i18n/test-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// jsdom has no layout; CodeMirror measures text with these.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  resetFileDrafts();
  resetFileTabs();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = (path: string, body: string, version: string): FileContent => ({ path, name: path, size: body.length, kind: 'text', text: body, version });
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => {
  await act(async () => (el as HTMLElement).click());
  await wait();
};
const view = () => EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
const type = async (more: string) => {
  await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert: more } }));
  await wait();
};
/** The editor is its own lazy chunk: wait until it is on the screen. */
const editorUp = async () => {
  for (let i = 0; i < 100 && !host.querySelector('.cm-editor'); i++) await wait(20);
  await wait(30);
};
const dot = () => host.querySelector('.ck-file-dot');
const shown = () => host.querySelector('.cm-content')!.textContent;

async function open(api: FilesApi, path = 'a.ts') {
  await act(async () => root.render(<FileTab paneId="p1" path={path} canTell={false} api={api} />));
  await wait();
  await click(button('Edit'));
  await editorUp();
}
const apiWith = (body = 'const a = 1;', over: Partial<FilesApi> = {}) => fakeApi({ ...over }, { 'a.ts': text('a.ts', body, 'v1') });
const conflict = () => Promise.reject(new Error('FILES_CONFLICT: The file changed on disk since you opened it.'));

describe('editing a file', () => {
  it('shows the editor with line numbers and no dirty dot until something is typed', async () => {
    await open(apiWith());
    expect(host.querySelector('[data-testid="file-edit"]')).not.toBeNull();
    expect(shown()).toContain('const a = 1;');
    expect(host.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length).toBeGreaterThan(0);
    expect(dot()).toBeNull();
    expect(button('Save')!.disabled).toBe(true);
    expect(button('Revert')!.disabled).toBe(true);
  });

  it('typing shows the dirty dot, Save writes with the opened version and clears it', async () => {
    const api = apiWith();
    await open(api);
    await type(' // hi');
    expect(dot()).not.toBeNull();
    expect(button('Save')!.disabled).toBe(false);
    await click(button('Save'));
    expect(api.write).toHaveBeenCalledWith('p1', 'a.ts', 'const a = 1; // hi', 'v1', false);
    expect(dot()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Saved.');
    expect(button('Save')!.disabled).toBe(true);
    // The next save starts from the version the first one returned.
    await type('!');
    await click(button('Save'));
    expect(api.write).toHaveBeenLastCalledWith('p1', 'a.ts', 'const a = 1; // hi!', `v-${'const a = 1; // hi'.length}`, false);
  });

  it('Ctrl+S in the editor saves', async () => {
    const api = apiWith();
    await open(api);
    await type('x');
    await act(async () => {
      host.querySelector('.cm-content')!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await wait();
    expect(api.write).toHaveBeenCalledTimes(1);
    expect(dot()).toBeNull();
  });

  it('Ctrl+F opens the find box inside the file', async () => {
    await open(apiWith());
    await act(async () => {
      host.querySelector('.cm-content')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 70, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await wait();
    expect(host.querySelector('.cm-search')).not.toBeNull();
  });

  it('Revert puts the opened text back', async () => {
    const api = apiWith();
    await open(api);
    await type(' more');
    await click(button('Revert'));
    await wait(30);
    expect(shown()).toBe('const a = 1;');
    expect(dot()).toBeNull();
    expect(api.write).not.toHaveBeenCalled();
  });

  it('typing the text back to what it was clears the dirty dot', async () => {
    await open(apiWith('ab'));
    await type('c');
    expect(dot()).not.toBeNull();
    await act(async () => view().dispatch({ changes: { from: 2, to: 3, insert: '' } }));
    await wait();
    expect(dot()).toBeNull();
  });

  it('a Windows file keeps its line ends when saved', async () => {
    const api = fakeApi({}, { 'a.ts': text('a.ts', 'one\r\ntwo', 'v1') });
    await open(api);
    await type('\nthree');
    await click(button('Save'));
    expect(api.write).toHaveBeenCalledWith('p1', 'a.ts', 'one\r\ntwo\r\nthree', 'v1', false);
    expect(toDisk('a\nb', true)).toBe('a\r\nb');
    expect(toDisk('a\r\nb', false)).toBe('a\nb');
    expect(normalise('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('Done is blocked while there are unsaved changes, and works after a save', async () => {
    await open(apiWith());
    await type('x');
    expect(button('Done')!.disabled).toBe(true);
    await click(button('Save'));
    await click(button('Done'));
    expect(host.querySelector('[data-testid="file-edit"]')).toBeNull();
    expect(button('Edit')).toBeDefined();
  });

  it('a failed save says why and keeps the text', async () => {
    const write = vi.fn(() => Promise.reject(new Error('FILES_IO: Could not save the file: access denied.')));
    await open(apiWith('a', { write }));
    await type('b');
    await click(button('Save'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Could not save the file: access denied.');
    expect(dot()).not.toBeNull();
    expect(shown()).toBe('ab');
  });
});

describe('a file changed on disk', () => {
  it('a save that finds a different file shows Reload / Keep mine and keeps my text', async () => {
    const write = vi.fn(conflict);
    await open(apiWith('mine', { write }));
    await type('!');
    await click(button('Save'));
    expect(host.querySelector('[data-testid="file-conflict"]')?.textContent).toContain('This file changed on disk.');
    expect(button('Reload')).toBeDefined();
    expect(button('Keep mine (overwrite)')).toBeDefined();
    expect(shown()).toBe('mine!');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('Keep mine saves again with overwrite', async () => {
    const write = vi.fn().mockImplementationOnce(conflict).mockImplementation(async (_p: string, path: string, t: string) => ({ path, size: t.length, version: 'v9' }));
    await open(apiWith('mine', { write }));
    await type('!');
    await click(button('Save'));
    await click(button('Keep mine (overwrite)'));
    expect(write).toHaveBeenLastCalledWith('p1', 'a.ts', 'mine!', 'v1', true);
    expect(host.querySelector('[data-testid="file-conflict"]')).toBeNull();
    expect(dot()).toBeNull();
  });

  it('Reload takes the disk version and drops my changes', async () => {
    const read = vi.fn(async (_p: string, path: string) => text(path, 'from the agent', 'v2'));
    await open(apiWith('mine', { write: vi.fn(conflict), read }));
    await type('!');
    read.mockClear();
    await click(button('Save'));
    await click(button('Reload'));
    await wait(30);
    expect(read).toHaveBeenCalled();
    expect(shown()).toBe('from the agent');
    expect(host.querySelector('[data-testid="file-conflict"]')).toBeNull();
    expect(dot()).toBeNull();
  });

  it('when the agent changes the file while I have unsaved text, the bar shows and my text stays', async () => {
    let disk = text('a.ts', 'mine', 'v1');
    const api = fakeApi({ read: vi.fn(async () => disk) });
    await act(async () => root.render(<FileTab paneId="p1" path="a.ts" canTell={false} api={api} refreshKey="a" />));
    await wait();
    await click(button('Edit'));
    await editorUp();
    await type('!');
    disk = text('a.ts', 'agent', 'v2');
    await act(async () => root.render(<FileTab paneId="p1" path="a.ts" canTell={false} api={api} refreshKey="b" />));
    await wait();
    expect(host.querySelector('[data-testid="file-conflict"]')).not.toBeNull();
    expect(shown()).toBe('mine!');
  });

  it('when I have not typed anything the editor just follows the agent', async () => {
    let disk = text('a.ts', 'mine', 'v1');
    const api = fakeApi({ read: vi.fn(async () => disk) });
    await act(async () => root.render(<FileTab paneId="p1" path="a.ts" canTell={false} api={api} refreshKey="a" />));
    await wait();
    await click(button('Edit'));
    await editorUp();
    disk = text('a.ts', 'agent', 'v2');
    await act(async () => root.render(<FileTab paneId="p1" path="a.ts" canTell={false} api={api} refreshKey="b" />));
    await wait(30);
    expect(host.querySelector('[data-testid="file-conflict"]')).toBeNull();
    expect(shown()).toBe('agent');
  });
});

describe('what is not edited', () => {
  it('Word, Excel and PDF files have no Edit button', async () => {
    for (const path of ['a.docx', 'a.xlsx', 'a.pdf']) {
      await act(async () => root.render(<FileTab paneId="p1" path={path} canTell={false} api={fakeApi()} />));
      await wait();
      expect(button('Edit'), path).toBeUndefined();
    }
  });

  it('a binary file and a too-big file have no Edit button', async () => {
    for (const kind of ['binary', 'too_large'] as const) {
      const api = fakeApi({}, { 'b.bin': { path: 'b.bin', name: 'b.bin', size: 5, kind } });
      await act(async () => root.render(<FileTab paneId="p1" path="b.bin" canTell={false} api={api} />));
      await wait();
      expect(button('Edit'), kind).toBeUndefined();
    }
  });
});

describe('the tab', () => {
  const bar = () => host.querySelector('[data-testid="file-tabs"]');
  const both = (key: string, api: FilesApi) => (
    <>
      <FileTabsBar paneId="p1" files={['a.ts']} active="file:a.ts" onPick={() => undefined} />
      <FileTab key={key} paneId="p1" path="a.ts" canTell={false} api={api} />
    </>
  );

  it('shows a dot on the file tab while there are unsaved changes, and it survives a switch away and back', async () => {
    const api = apiWith();
    await act(async () => root.render(both('one', api)));
    await wait();
    await click(button('Edit'));
    await editorUp();
    expect(bar()!.querySelector('.ck-ftab-dot')).toBeNull();
    await type(' more');
    expect(bar()!.querySelector('.ck-ftab-dot')).not.toBeNull();
    // Switch away (the file tab is built again each time) and back: the unsaved text is still there.
    await act(async () => root.render(both('two', api)));
    await wait(30);
    expect(shown()).toBe('const a = 1; more');
    expect(bar()!.querySelector('.ck-ftab-dot')).not.toBeNull();
    expect(dot()).not.toBeNull();
  });

  it('closing a tab with unsaved changes asks first', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    openFileTab('p1', 'a.ts');
    await act(async () => root.render(both('one', apiWith())));
    await wait();
    await click(button('Edit'));
    await editorUp();
    await type('x');
    await click(host.querySelector('.ck-ftab-x'));
    expect(confirm).toHaveBeenCalled();
    expect(bar()!.querySelector('.ck-ftab-dot')).not.toBeNull();
    confirm.mockReturnValue(true);
    await click(host.querySelector('.ck-ftab-x'));
    expect(bar()?.querySelector('.ck-ftab-dot') ?? null).toBeNull();
    confirm.mockRestore();
  });
});
