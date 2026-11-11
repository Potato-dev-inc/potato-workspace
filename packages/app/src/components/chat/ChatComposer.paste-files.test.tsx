// @vitest-environment jsdom
// Ctrl+V in the chat box with files on the clipboard: one file, several, an image, a folder, the Explorer path list
// (CF_HDROP) read by the desktop app, and plain text that still pastes as text. The clipboard is a fake (setFileClipboard).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatComposer } from './ChatComposer';
import { setFileClipboard, type FileClipboard } from '../../lib/pasteFiles';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

/** A fake backend: prepare describes each path (a folder when it has no extension); saved pastes get a path. */
function backend(cmd: string, args?: unknown, clipboardPaths: string[] = []): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case 'attachment_prepare':
      return (a.paths as string[]).map((path) => {
        const name = path.split(/[\\/]/).pop() ?? path;
        const folder = !name.includes('.');
        return { name, path, kind: folder ? 'folder' : 'text', size: folder ? 3 : 2048, mime: folder ? 'inode/directory' : undefined };
      });
    case 'attachment_save_pasted':
      return { name: a.name, path: `/proj/.potato-workspace/attachments/${a.name}`, kind: 'image', size: 3, mime: a.mime };
    case 'attachment_preview':
      return null;
    case 'clipboard_file_paths':
      return clipboardPaths;
    default:
      return null;
  }
}

/** A fake clipboard that holds these file paths (what Explorer put there). */
function fakeClipboard(paths: string[]): FileClipboard & { filePaths: ReturnType<typeof vi.fn> } {
  return { filePaths: vi.fn(async () => paths) };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => backend(cmd, args));
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  setFileClipboard(null);
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const settle = async () => {
  for (let i = 0; i < 8; i++) await flush();
};
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const chipNames = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]')).map((el) => el.getAttribute('data-name'));

function mount(draftKey = 'pane-1') {
  const onSend = vi.fn(async () => null);
  act(() =>
    root.render(<ChatComposer onSend={onSend} blockedReason={null} draftKey={draftKey} attachFiles={async () => []} />),
  );
  return onSend;
}

/** Dispatches a paste on the box. `files` are what the webview gives; `text` is the plain-text part of the clipboard. */
function paste(files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [], types: text ? ['text/plain'] : [], getData: (type: string) => (type === 'text/plain' ? text : '') } });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

describe('ChatComposer paste of files from the clipboard', () => {
  it('one file copied in Explorer becomes one chip', async () => {
    const clip = fakeClipboard(['C:\\Users\\me\\notes.md']);
    setFileClipboard(clip);
    mount();
    const event = paste([]);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(clip.filePaths).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('attachment_prepare', expect.objectContaining({ paneId: 'pane-1', paths: ['C:\\Users\\me\\notes.md'] }));
    expect(chipNames()).toEqual(['notes.md']);
    expect(field().value).toBe('');
  });

  it('several files copied at once each get a chip, in order', async () => {
    setFileClipboard(fakeClipboard(['C:\\a\\notes.md', 'C:\\a\\data.csv', 'C:\\a\\shot.png']));
    mount();
    paste([]);
    await settle();
    expect(chipNames()).toEqual(['notes.md', 'data.csv', 'shot.png']);
  });

  it('a folder copied in Explorer is attached by its path, as a folder chip', async () => {
    setFileClipboard(fakeClipboard(['C:\\work\\src']));
    mount();
    paste([]);
    await settle();
    expect(chipNames()).toEqual(['src']);
    expect(host.querySelector('[data-testid="attachment-chip"][data-name="src"]')?.getAttribute('data-kind')).toBe('folder');
  });

  it('the path list the desktop app reads (CF_HDROP) is used when the desktop clipboard is the source', async () => {
    setFileClipboard(null);
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
      backend(cmd, args, cmd === 'clipboard_file_paths' ? ['C:\\Users\\me\\one.txt', 'C:\\Users\\me\\two.txt'] : []),
    );
    mount();
    paste([]);
    await settle();
    expect(invoke).toHaveBeenCalledWith('clipboard_file_paths');
    expect(chipNames()).toEqual(['one.txt', 'two.txt']);
  });

  it('a file the webview gives without a path is read from the clipboard instead', async () => {
    const clip = fakeClipboard(['C:\\Users\\me\\report.pdf']);
    setFileClipboard(clip);
    mount();
    const noPath = new File(['x'], 'report.pdf', { type: 'application/pdf' });
    paste([noPath]);
    await settle();
    expect(clip.filePaths).toHaveBeenCalledTimes(1);
    expect(chipNames()).toEqual(['report.pdf']);
  });

  it('an image is saved for the pane and the clipboard is not asked', async () => {
    const clip = fakeClipboard(['C:\\should\\not\\be\\read.png']);
    setFileClipboard(clip);
    mount();
    const png = new File(['pngdata'], 'shot.png', { type: 'image/png' });
    paste([png]);
    await settle();
    expect(clip.filePaths).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('attachment_save_pasted', expect.objectContaining({ paneId: 'pane-1', name: 'Pasted image 1.png' }));
    expect(chipNames()).toEqual(['Pasted image 1.png']);
  });

  it('plain text still pastes as text: no chips, the default is left alone, the clipboard is not asked', async () => {
    const clip = fakeClipboard(['C:\\should\\not\\be\\read.md']);
    setFileClipboard(clip);
    mount();
    const event = paste([], 'hello there');
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(clip.filePaths).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('clipboard_file_paths');
    expect(chipNames()).toEqual([]);
  });

  it('a file that is already attached is not added twice', async () => {
    setFileClipboard(fakeClipboard(['C:\\a\\notes.md']));
    mount();
    paste([]);
    await settle();
    paste([]);
    await settle();
    expect(chipNames()).toEqual(['notes.md']);
  });
});
