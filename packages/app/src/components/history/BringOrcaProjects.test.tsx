// @vitest-environment jsdom
// "Bring my projects from Orca", screen level: it sits inside the Bring my chats panel, shows only when Orca was
// found, lists projects with checkboxes, and Add writes to the sidebar's project list. A fake Orca answer; no file read.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as chatImport from '../../lib/chatImport';
import type { ImportApi, ImportFound } from '../../lib/chatImport';
import type { OrcaImportApi, OrcaScan } from '../../lib/orcaImport';
import { readProjects } from '../../lib/sidebarProjects';
import { BringChatsPanel } from './BringChatsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const AGENT: ImportFound = { id: 'alpha', label: 'Alpha', fromDefinition: false, chats: 2, bytes: 1, oldestMs: null, newestMs: null, already: 0, tooBig: 0, places: [], canContinue: true };
const chatApi = (): ImportApi =>
  ({
    state: async () => ({ asked: false, indexEnabled: true, agents: [], progress: chatImport.idleProgress() }),
    look: async () => [AGENT],
  }) as unknown as ImportApi;

const SCAN: OrcaScan = {
  found: true,
  projects: [
    { path: 'C:/work/alpha-app', name: 'Alpha', exists: true },
    { path: 'C:/work/gone', name: 'Gone', exists: false },
    { path: 'C:/work/beta-site', name: 'Beta', exists: true },
  ],
  chats: [],
};
const orcaApi = (scan: OrcaScan | Error): OrcaImportApi => ({
  scan: async () => {
    if (scan instanceof Error) throw scan;
    return scan;
  },
  check: async (paths) => SCAN.projects.filter((p) => paths.includes(p.path) && p.exists),
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));

async function open(scan: OrcaScan | Error) {
  await act(async () => root.render(<BringChatsPanel api={chatApi()} orcaApi={orcaApi(scan)} />));
  await flush();
}

describe('Bring my projects from Orca', () => {
  it('is hidden when Orca is not found', async () => {
    await open({ found: false, projects: [], chats: [] });
    expect(button('Bring my projects from Orca')).toBeUndefined();
    expect(host.textContent).toContain('Alpha');
  });

  it('is hidden when the look fails', async () => {
    await open(new Error('no'));
    expect(button('Bring my projects from Orca')).toBeUndefined();
  });

  it('lists the projects, adds the checked ones to the sidebar list and says how many', async () => {
    let seen = 0;
    window.addEventListener('storage', () => seen++);
    await open(SCAN);
    await act(async () => button('Bring my projects from Orca')!.click());
    const boxes = [...host.querySelectorAll<HTMLInputElement>('[data-testid="orca-projects"] input[type="checkbox"]')];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, false], [false, true], [true, false]]);
    expect(host.textContent).toContain('Folder not found');
    await act(async () => boxes[2].click());
    await act(async () => button('Add (1)')!.click());
    await flush();
    expect(readProjects().map((p) => p.path)).toEqual(['C:/work/alpha-app']);
    expect(host.textContent).toContain('1 project added.');
    expect(seen).toBeGreaterThan(0);
  });

  it('marks a project that is already in the sidebar and does not add it twice', async () => {
    localStorage.setItem('pm.sidebar.projects', JSON.stringify([{ path: 'c:/Work/alpha-app' }]));
    await open(SCAN);
    await act(async () => button('Bring my projects from Orca')!.click());
    expect(host.textContent).toContain('Already added');
    await act(async () => button('Add (1)')!.click());
    await flush();
    expect(readProjects().map((p) => p.path)).toEqual(['c:/Work/alpha-app', 'C:/work/beta-site']);
  });
});
