// @vitest-environment jsdom
// A far PC's notes ("Asleep or off. Try again", "needs a person") are drawn inside that PC's own project card, not between the project above it and the card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MAC_MINI } from '../../dev/devices-fixtures';
import { deviceLocation } from '../../lib/projectLocation';
import { RemoteProjects } from './RemoteProjects';
import type { ProjectEntry } from './useAllProjects';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => act(async () => root?.unmount()));

describe('far PC notes sit in the far group', () => {
  it('the note is inside the first project card of its PC', async () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    const device = { ...MAC_MINI, state: 'asleep' as const, path: null };
    const rows = [{ key: `dev:${device.node}:p1`, node: device.node, paneId: 'p1', agent: 'claude', title: 'Chat 1', cwd: '/work/app', status: 'idle', parent: null, project: 'app' }] as never;
    const entry: ProjectEntry = { key: `dev:${device.node}:app`, name: 'app', path: null, location: deviceLocation(device.node, device.name), rows };
    await act(async () => root!.render(<RemoteProjects groups={[{ device, rows }]} entries={[entry]} selectedKey={null} onOpen={() => undefined} launchEntries={[]} />));
    const card = box.querySelector(`[data-testid="device-project-${entry.key}"]`)!;
    expect(card.querySelector('.dev-group-note, [data-testid="device-notices"]')).not.toBeNull();
    expect(card.textContent).toContain('Asleep or off.');
  });
});
