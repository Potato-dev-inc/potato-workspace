// @vitest-environment jsdom
// A chat of another PC: a right-click (or the context-menu key) and the "···" button open the app's row menu, never the browser's.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_MINI } from '../../dev/devices-fixtures';
import { deviceLocation } from '../../lib/projectLocation';
import { RemoteProjects } from './RemoteProjects';
import type { ProjectEntry } from './useAllProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];
beforeEach(async () => {
  window.localStorage.clear();
  opened.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const rows = [{ key: `dev:${MAC_MINI.node}:p1`, node: MAC_MINI.node, paneId: 'p1', agent: 'claude', title: 'Chat p1', cwd: '/work/app', status: 'idle', parent: null, project: 'app' }] as never;
  const entry: ProjectEntry = { key: `dev:${MAC_MINI.node}:app`, name: 'app', path: null, location: deviceLocation(MAC_MINI.node, MAC_MINI.name), rows: rows as ProjectEntry['rows'] };
  await act(async () =>
    root.render(<RemoteProjects groups={[{ device: MAC_MINI, rows }]} entries={[entry]} selectedKey={null} onOpen={(r) => opened.push(r.key)} launchEntries={[]} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const rowBtn = () => host.querySelector<HTMLElement>('[data-pane-row]')!;
const menu = () => document.querySelector('[role="menu"]');
const context = (init: MouseEventInit) => {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...init });
  act(() => void rowBtn().dispatchEvent(ev));
  return ev;
};

describe('far chat row menu', () => {
  it('right-click opens the app menu and cancels the browser one', () => {
    const ev = context({ clientX: 40, clientY: 50 });
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it('the context-menu key (no pointer) opens it too', () => {
    const ev = context({ clientX: 0, clientY: 0 });
    expect(ev.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it('the "···" button opens the same menu, and Open opens the chat', async () => {
    const more = host.querySelector<HTMLButtonElement>('.ck-row-more')!;
    expect(more.disabled).toBe(false);
    await act(async () => more.click());
    const item = menu()!.querySelector<HTMLElement>('[role="menuitem"]')!;
    await act(async () => item.click());
    expect(opened).toEqual([`dev:${MAC_MINI.node}:p1`]);
    expect(menu()).toBeNull();
  });

  it('a right-click elsewhere in the sidebar keeps the default behaviour', () => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => void host.querySelector('.ck-proj')!.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false);
  });
});
