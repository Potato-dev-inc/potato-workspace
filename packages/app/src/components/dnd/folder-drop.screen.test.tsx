// @vitest-environment jsdom
// Screen level: a folder dragged from Windows onto the sidebar asks "Add as a project?"; nothing is added until yes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { GitState, ShipApi } from '../../lib/ship-api';

vi.mock('../../lib/dropFiles', async (orig) => ({
  ...(await orig<typeof import('../../lib/dropFiles')>()),
  // The desktop app tells folders from files; here a name ending in .txt is a file.
  pathKinds: vi.fn(async (paths: readonly string[]) => paths.map((p) => (p.endsWith('.txt') ? 'file' : 'dir'))),
}));

import { Sidebar } from '../cockpit/Sidebar';
import { setFileDropSource, type WindowDropEvent } from '../../lib/fileDrop';
import { LS_SIDEBAR_PROJECTS } from '../../lib/sidebarProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement;
let root: Root;
let emit: (e: WindowDropEvent) => void = () => {};

function fakeApi(): CockpitApi {
  const pane = { info: { id: 'p1', agent_type: 'codex', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null } as unknown as PaneInfo, status: 'idle' };
  return {
    registry: { paneList: [pane], panes: new Map([['p1', pane]]), initialReady: true },
    names: new Map([['p1', 'Codex']]),
    asked: { questions: [] },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
  } as unknown as CockpitApi;
}
const ship = { recent: vi.fn(async () => []), gitState: vi.fn(async () => 'repo' as unknown as GitState), gitInitPlan: vi.fn(), gitInit: vi.fn(), forget: vi.fn(), pickFolder: vi.fn() } as unknown as ShipApi;
const projects = () => JSON.parse(localStorage.getItem(LS_SIDEBAR_PROJECTS) ?? '[]') as Array<{ path: string }>;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === label)!;
const drop = (paths: string[], x = 50) => act(async () => emit({ type: 'drop', paths, position: { x, y: 100 } }));

beforeEach(async () => {
  localStorage.clear();
  setFileDropSource(async (cb) => {
    emit = cb;
    return () => undefined;
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // The sidebar is the box 0-260 x 0-700.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const side = this.tagName === 'ASIDE';
    return { left: 0, right: side ? 260 : 0, top: 0, bottom: side ? 700 : 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  await act(async () => root.render(<Sidebar c={fakeApi()} onOpenPalette={() => {}} ship={ship} />));
  await act(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setFileDropSource(null);
  vi.restoreAllMocks();
});

describe('drop a folder on the sidebar', () => {
  it('asks first, and adds the project only after yes', async () => {
    await drop(['C:\\code\\my-shop']);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Add as a project?');
    expect(dialog?.textContent).toContain('"my-shop"');
    expect(projects()).toEqual([]);
    await act(async () => button('Add project').click());
    expect(projects().map((p) => p.path)).toEqual(['C:\\code\\my-shop']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Not now adds nothing', async () => {
    await drop(['C:\\code\\my-shop']);
    await act(async () => button('Not now').click());
    expect(projects()).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Esc closes the question', async () => {
    await drop(['C:\\code\\my-shop']);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(projects()).toEqual([]);
  });

  it('a file is not offered as a project', async () => {
    await drop(['C:\\code\\notes.txt']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a drop away from the sidebar does nothing', async () => {
    await drop(['C:\\code\\my-shop'], 900);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('says what it takes while a folder is over the sidebar', async () => {
    await act(async () => emit({ type: 'over', position: { x: 50, y: 100 } }));
    expect(host.querySelector('.ck-side-dropnote')?.textContent).toBe('Drop a folder to add it as a project');
    await act(async () => emit({ type: 'leave' }));
    expect(host.querySelector('.ck-side-dropnote')).toBeNull();
  });
});
