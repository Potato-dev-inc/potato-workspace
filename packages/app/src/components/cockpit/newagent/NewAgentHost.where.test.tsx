// @vitest-environment jsdom
// "Where" on the full New agent page (Labs `devices_enabled`), through the real NewAgentHost + NewAgentPage: the pill sits in the
// composer row before the project pill; it lists This PC, a paired device and an SSH machine; an offline device cannot be picked;
// picking the Mac swaps the folders and the agents for the Mac's own and Start goes through the device link; the place is
// remembered per project; nothing is drawn while the Labs switch is off. Only the device link and the command layers are fakes.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../../dev/devices-fixtures';
import { BUILD_BOX, SshFake } from '../../../dev/ssh-fixtures';
import type { CockpitApi } from '../../../hooks/useCockpit';
import type { WslApi } from '../../../lib/wsl';
import { click, settle, type as typeInto } from '../../settings/test-utils';
import type { WhereProps } from '../../devices/NewAgentWhere';
import { NewAgentHost } from './NewAgentHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
});

function fakeApi(): CockpitApi {
  return {
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
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
    newAgent: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  } as unknown as CockpitApi;
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

function fakeWsl(): WslApi {
  return {
    status: async () => ({ state: 'ready' as const, distros: [{ name: 'Ubuntu-Test', default: true, version: 2, state: 'Running' }] }),
    check: async () => {
      throw new Error('never called');
    },
    placesGet: async () => [{ agentId: 'claude', label: 'Claude', distro: null, found: null, whyNot: null }],
    placeSet: async () => {
      throw new Error('never called');
    },
    spawnInLinux: async () => 'wsl-pane-1',
  } as unknown as WslApi;
}

function whereOf(fake: DevicesFake, extra: Partial<WhereProps> = {}): WhereProps {
  return { view: fake.view, api: fake, ssh: new SshFake({ hosts: [BUILD_BOX] }), wsl: fakeWsl(), onAddDevice: () => {}, onStarted: () => {}, ...extra };
}

async function open(where: WhereProps | undefined, project: { path: string; name: string } | null = null) {
  await act(async () => root.render(<NewAgentHost c={fakeApi()} where={where} project={project} />));
  await settle(6);
}

describe('New agent page: Where', () => {
  it('draws the pill in the composer row, before the project pill, listing This PC, the devices and the SSH machines', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    const row = q('.ck-na-row')!;
    const pill = row.querySelector('[data-testid="where-pill"]')!;
    const project = row.querySelector('[data-testid="na-folder"]')!;
    expect(pill.textContent).toContain('This PC');
    expect(pill.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not also drawn above the page.
    expect(document.querySelectorAll('[data-testid="where-pill"]')).toHaveLength(1);
    await click(pill);
    await settle(4);
    expect([...q('.dev-where-menu')!.querySelectorAll('.dev-where-row > span')].map((s) => s.textContent)).toEqual(['This PC', 'Ubuntu-Test', 'Mac mini', 'Work laptop', 'Build box', 'Add a device…']);
  });

  it('an offline device is listed with its state and cannot be picked', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    await click(q('[data-testid="where-pill"]'));
    const laptop = q<HTMLButtonElement>(`[data-testid="where-${WORK_LAPTOP.node}"]`)!;
    expect(laptop.disabled).toBe(true);
    expect(laptop.textContent).toContain('Offline.');
    await click(laptop);
    await settle(4);
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('This PC');
    expect(q('[data-testid="phone-new-chat"]')).toBeNull();
  });

  it('picking the Mac swaps the folders and agents for the Mac\'s own, keeps the pill in the row, and Start goes through the device link', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const onStarted = vi.fn();
    await open(whereOf(fake, { onStarted: onStarted as never }));
    await click(q('[data-testid="where-pill"]'));
    await click(q(`[data-testid="where-${NODE_MAC}"]`));
    await settle(8);
    expect(q('[data-testid="phone-new-chat"]')).not.toBeNull();
    expect(q('[data-testid="na-folder"]')).toBeNull();
    const pill = q('.ph-nc-pills [data-testid="where-pill"]')!;
    expect(pill.textContent).toContain('Mac mini');
    expect(pill.compareDocumentPosition(q('[data-testid="nc-project-pill"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fake.requests.some((r) => r.node === NODE_MAC && r.path === '/phone/new-chat')).toBe(true);
    expect([...document.querySelectorAll('[data-testid="nc-agent-tile"]')].map((t) => t.textContent)).toEqual(['Claude', 'Codex'].map((n) => expect.stringContaining(n)));
    expect(q('[data-testid="nc-project-pill"]')!.textContent).toContain('app');
    await typeInto(q<HTMLTextAreaElement>('textarea')!, 'Build the dmg');
    await click(q('button.ph-comp-send'));
    await settle(8);
    expect(fake.requests.find((r) => r.path === '/phone/chats')).toMatchObject({ node: NODE_MAC, method: 'POST', body: { agent: 'claude', project: 'proj-app' } });
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStarted.mock.calls[0]![0]).toMatchObject({ node: NODE_MAC });
  });

  it('can go back to This PC from the pill on the Mac\'s body', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    await open(whereOf(fake));
    await click(q('[data-testid="where-pill"]'));
    await click(q(`[data-testid="where-${NODE_MAC}"]`));
    await settle(6);
    await click(q('[data-testid="where-pill"]'));
    await click(q('[data-testid="where-this"]'));
    await settle(4);
    expect(q('[data-testid="phone-new-chat"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('This PC');
  });

  it('an SSH machine gets the terminal-only body with the pill kept first', async () => {
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI] })));
    await click(q('[data-testid="where-pill"]'));
    await click(q('[data-testid="where-ssh:' + BUILD_BOX.id + '"]'));
    await settle(6);
    const panel = q('[data-testid="ssh-panel"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-testid="where-pill"]')!.textContent).toContain('Build box');
    expect(panel.querySelector('[data-testid="where-pill"]')!.compareDocumentPosition(panel.querySelector('.dev-note')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).toContain('terminal');
  });

  it('remembers the last place per project', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [MAC_MINI] });
    const w = whereOf(fake);
    await open(w, { path: '/work/alpha', name: 'alpha' });
    await click(q('[data-testid="where-pill"]'));
    await click(q(`[data-testid="where-${NODE_MAC}"]`));
    await settle(6);
    await act(async () => root.unmount());
    root = createRoot(host);
    // The same project opens on the Mac again; another project opens on This PC.
    await open(w, { path: '/work/alpha', name: 'alpha' });
    expect(q('[data-testid="phone-new-chat"]')).not.toBeNull();
    expect(q('[data-testid="where-pill"]')!.textContent).toContain('Mac mini');
    await act(async () => root.render(<NewAgentHost c={fakeApi()} where={w} project={{ path: '/work/beta', name: 'beta' }} />));
    await settle(6);
    expect(q('[data-testid="phone-new-chat"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('This PC');
  });

  it('a remembered device that is offline now falls back to This PC', async () => {
    window.localStorage.setItem('pm.newAgent.where', JSON.stringify({ '': WORK_LAPTOP.node }));
    await open(whereOf(new DevicesFake({ enabled: true, devices: [MAC_MINI, WORK_LAPTOP] })));
    expect(q('[data-testid="phone-new-chat"]')).toBeNull();
    expect(q('.ck-na-row [data-testid="where-pill"]')!.textContent).toContain('This PC');
  });

  it('is not drawn while the Labs switch is off, or without devices at all', async () => {
    await open(whereOf(new DevicesFake({ enabled: false, devices: [MAC_MINI] })));
    expect(q('[data-testid="where"]')).toBeNull();
    expect(q('[data-testid="na-folder"]')).not.toBeNull();
    await act(async () => root.render(<NewAgentHost c={fakeApi()} />));
    await settle(4);
    expect(q('[data-testid="where"]')).toBeNull();
  });
});
