// @vitest-environment jsdom
// The pop-out bookkeeping: which tab leaves the pane, and what brings it back. The backend is a fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTabClosed, isChatInWindow, openChatInWindow, openFileInWindow, putChatBack, resetTabWindows, type TabWindowsApi } from './tab-windows';
import { openFileTab, resetFileTabs, usePaneFiles } from './file-tabs';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const api = (fail = false): TabWindowsApi => ({
  open: vi.fn(async () => {
    if (fail) throw new Error('no');
  }),
  putBack: vi.fn(async () => undefined),
  onClosed: vi.fn(async () => () => undefined),
});

let files: readonly string[] = [];
function Probe() {
  files = usePaneFiles('p').files;
  return null;
}
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetFileTabs();
  resetTabWindows();
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(<Probe />));
});
afterEach(() => host.remove());

describe('pulling a tab out', () => {
  it('a file leaves the tab row only after its window opened, and comes back on the close event', async () => {
    act(() => openFileTab('p', 'a.txt'));
    expect(files).toEqual(['a.txt']);
    const a = api();
    await act(async () => openFileInWindow('p', 'a.txt', 'a.txt', a));
    expect(a.open).toHaveBeenCalledWith('p', 'file:a.txt', 'a.txt');
    expect(files).toEqual([]);
    act(() => applyTabClosed({ paneId: 'p', tab: 'file:a.txt' }));
    expect(files).toEqual(['a.txt']);
  });

  it('a window that fails to open leaves the file where it was', async () => {
    act(() => openFileTab('p', 'a.txt'));
    await expect(openFileInWindow('p', 'a.txt', 'a.txt', api(true))).rejects.toThrow();
    expect(files).toEqual(['a.txt']);
  });

  it('the chat is marked out only after its window opened, and unmarked on the close event', async () => {
    await expect(openChatInWindow('p', 'Claude', api(true))).rejects.toThrow();
    expect(isChatInWindow('p')).toBe(false);
    const a = api();
    await openChatInWindow('p', 'Claude', a);
    expect(a.open).toHaveBeenCalledWith('p', 'chat', 'Claude');
    expect(isChatInWindow('p')).toBe(true);
    await putChatBack('p', a);
    expect(a.putBack).toHaveBeenCalledWith('p', 'chat');
    act(() => applyTabClosed({ paneId: 'p', tab: 'chat' }));
    expect(isChatInWindow('p')).toBe(false);
  });

  it('a close event for a tab that is not a file or the chat changes nothing', () => {
    act(() => applyTabClosed({ paneId: 'p', tab: 'terminal' }));
    expect(files).toEqual([]);
    expect(isChatInWindow('p')).toBe(false);
  });
});
