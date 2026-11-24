// @vitest-environment jsdom
// A far chat that needs an answer keeps its place in the project: attention is a marker, not a position.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MAC_MINI } from '../../dev/devices-fixtures';
import { deviceLocation } from '../../lib/projectLocation';
import { RemoteProjects } from './RemoteProjects';
import type { ProjectEntry } from './useAllProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function titles(statuses: string[]) {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const rows = statuses.map((status, i) => ({ key: `dev:${MAC_MINI.node}:p${i}`, node: MAC_MINI.node, paneId: `p${i}`, agent: 'claude', title: `Chat ${i}`, cwd: '/work/app', status, parent: null, project: 'app' })) as never;
  const entry: ProjectEntry = { key: `dev:${MAC_MINI.node}:app`, name: 'app', path: null, location: deviceLocation(MAC_MINI.node, MAC_MINI.name), rows: rows as ProjectEntry['rows'] };
  await act(async () => root.render(<RemoteProjects groups={[{ device: MAC_MINI, rows }]} entries={[entry]} selectedKey={null} onOpen={() => {}} launchEntries={[]} />));
  return [...host.querySelectorAll('[data-pane-row]')].map((b) => b.textContent ?? '');
}

describe('far chat order', () => {
  it('is the same whether or not a chat waits for an answer', async () => {
    const calm = await titles(['idle', 'idle', 'idle']);
    await act(async () => root.unmount());
    host.remove();
    const asking = await titles(['idle', 'idle', 'waiting_input']);
    expect(calm).toHaveLength(3);
    expect(asking.map((s) => s.replace(/\D/g, '')[0])).toEqual(calm.map((s) => s.replace(/\D/g, '')[0]));
  });
});
