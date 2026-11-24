// @vitest-environment jsdom
// A far project card shows the same branch rows as a local one ("main primary", "pm/chat-x copy"), and a chat that ended while its PC was off
// stays in the list, said as ended, until it is closed.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAC_MINI } from '../../dev/devices-fixtures';
import { useEnglish } from '../../i18n/test-utils';
import { deviceLocation } from '../../lib/projectLocation';
import { RemoteProjects } from './RemoteProjects';
import type { ProjectEntry } from './useAllProjects';

useEnglish();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let box: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
});
afterEach(async () => act(async () => root?.unmount()));

const row = (id: string, extra: Record<string, unknown> = {}) => ({ key: `dev:${MAC_MINI.node}:${id}`, node: MAC_MINI.node, paneId: id, agent: 'claude', title: '', cwd: 'app', status: 'idle', project: 'app', chat: true, ...extra });
const render = async (rows: unknown[]) => {
  const entry: ProjectEntry = { key: `dev:${MAC_MINI.node}:app`, name: 'app', path: null, location: deviceLocation(MAC_MINI.node, MAC_MINI.name), rows: rows as never };
  await act(async () => root!.render(<RemoteProjects groups={[{ device: MAC_MINI, rows: rows as never }]} entries={[entry]} selectedKey={null} onOpen={() => undefined} launchEntries={[]} />));
};

describe('far project card', () => {
  it('one branch for every chat: named once on the card, as on this PC', async () => {
    await render([row('a', { branch: 'main' }), row('b', { branch: 'main' })]);
    expect(box.querySelector('.ck-proj-meta')?.textContent).toContain('main');
    expect(box.querySelector('.ck-branch-group')).toBeNull();
  });

  it('a chat on a copy gets its own "copy" group beside the primary one', async () => {
    await render([row('a', { branch: 'main' }), row('b', { branch: 'pm/chat-1', copy: true })]);
    const heads = [...box.querySelectorAll('.ck-branch-head')].map((h) => h.textContent);
    expect(heads).toEqual(['mainprimary', 'pm/chat-1copy']);
  });

  it('a chat that ended while its PC was off keeps its row and says ended', async () => {
    await render([row('a', { status: 'exited', ended: true, title: 'Fix login' })]);
    const r = box.querySelector('[data-pane-row]')!;
    expect(r.textContent).toContain('ended');
  });

  it('a PC that is away shows no working mark', async () => {
    const off = { ...MAC_MINI, state: 'offline' as const, path: null };
    const rows = [row('a', { status: 'running' })];
    const entry: ProjectEntry = { key: `dev:${off.node}:app`, name: 'app', path: null, location: deviceLocation(off.node, off.name), rows: rows as never };
    await act(async () => root!.render(<RemoteProjects groups={[{ device: off, rows: rows as never }]} entries={[entry]} selectedKey={null} onOpen={() => undefined} launchEntries={[]} />));
    expect(box.querySelector('[data-pane-row]')!.className).toContain('is-ended');
  });
});
