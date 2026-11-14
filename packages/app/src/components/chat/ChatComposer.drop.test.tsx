// @vitest-environment jsdom
// Files from Explorer dropped anywhere on the chat (not only on the box) become chips, through the same path as the
// attach button. While they hover, the chat says "Drop to attach". A folder is attached by its path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatComposer } from './ChatComposer';
import { setFileDropSource, type WindowDropEvent } from '../../lib/fileDrop';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let send: (e: WindowDropEvent) => void = () => undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd !== 'attachment_prepare') return null;
    return ((args as { paths: string[] }).paths).map((path) =>
      path.endsWith('src') ? { name: 'src', path, kind: 'folder', size: 12 } : { name: path.split('/').pop(), path, kind: 'text', size: 10 },
    );
  });
  localStorage.clear();
  setFileDropSource(async (cb) => {
    send = cb;
    return () => undefined;
  });
});
afterEach(() => {
  setFileDropSource(null);
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setImmediate(r)); });
};

function mount() {
  act(() =>
    root.render(
      <div className="ck-chat" data-testid="chat-area">
        <ChatComposer onSend={vi.fn(async () => null)} blockedReason={null} draftKey="pane-1" attachFiles={async () => []} />
      </div>,
    ),
  );
  const area = host.querySelector<HTMLElement>('[data-testid="chat-area"]')!;
  // The chat is big, the box is tiny (jsdom has no layout): a drop inside the chat but outside the box must count.
  area.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
  const form = host.querySelector<HTMLElement>('form')!;
  form.getBoundingClientRect = () => ({ left: 0, top: 550, right: 600, bottom: 600, width: 600, height: 50, x: 0, y: 550, toJSON: () => ({}) });
  return area;
}
const chipNames = () => [...host.querySelectorAll('[data-testid="attachment-chip"]')].map((el) => el.getAttribute('data-name'));

describe('drop files on the chat', () => {
  it('shows "Drop to attach" over the chat while files hover, and removes it on leave', async () => {
    const area = mount();
    await settle();
    act(() => send({ type: 'over', position: { x: 100, y: 100 } }));
    expect(area.dataset.fileOver).toBe('true');
    expect(area.dataset.dropLabel).toBe('Drop to attach');
    act(() => send({ type: 'leave' }));
    expect(area.dataset.fileOver).toBeUndefined();
  });

  it('a drop high in the chat (away from the box) attaches the file', async () => {
    const area = mount();
    await settle();
    act(() => send({ type: 'drop', paths: ['/a/notes.md'], position: { x: 100, y: 100 } }));
    await settle();
    expect(chipNames()).toEqual(['notes.md']);
    expect(area.dataset.fileOver).toBeUndefined();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('attachment_prepare', { paneId: 'pane-1', paths: ['/a/notes.md'] });
  });

  it('a folder is attached by its path as a folder chip', async () => {
    mount();
    await settle();
    act(() => send({ type: 'drop', paths: ['/proj/src'], position: { x: 10, y: 10 } }));
    await settle();
    expect(chipNames()).toEqual(['src']);
  });

  it('a drop outside the chat attaches nothing', async () => {
    mount();
    await settle();
    act(() => send({ type: 'drop', paths: ['/a/notes.md'], position: { x: 900, y: 900 } }));
    await settle();
    expect(chipNames()).toEqual([]);
  });
});
