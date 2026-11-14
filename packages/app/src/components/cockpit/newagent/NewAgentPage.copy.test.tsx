// @vitest-environment jsdom
// "Work on a copy" on the New agent page, for a chat: the switch is off by default, is remembered per project, shows for a
// Git project and for a folder without Git (a plain trial copy), and what it says reaches the start request.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi, AddonStatus } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { forceShowTerminals } from '../../../lib/showTerminals';
import type { GitState, RecentProject } from '../../../lib/ship-api';
import type { NewAgentApi } from './api';
import type { LaneView, StartRequest } from './model';
import { NewAgentPage, type NewAgentPageProps } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;
const lanes: LaneView = { labsEnabled: true, agents: [{ id: 'claude', lane: 'terminal', disabled: false }] };
const installed = (id: string): AddonStatus => ({ agent: id, label: id, state: 'installed', version: '1', pinned_version: '1', detail: '', size_mb: 1, lines: [], signin_hint: '' });
const addonApi: AcpAddonApi = {
  list: async () => ({ labsEnabled: true, addons: [installed('claude')] }),
  install: vi.fn(async (id: string) => installed(id)),
  remove: vi.fn(async (id: string) => installed(id)),
  watch: async () => () => undefined,
};
const projectIn = (state: GitState): RecentProject => ({ path: '/work/alpha-app', name: 'alpha-app', state, last_used_ms: 5 });

const pageApi = (state: GitState): NewAgentApi => ({
  recent: async () => [projectIn(state)],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => state,
  lanes: async () => lanes,
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  forceShowTerminals(false);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  forceShowTerminals(true);
  await act(async () => root.unmount());
  host.remove();
});

async function mount(state: GitState, props: Partial<NewAgentPageProps> = {}) {
  const onStart = vi.fn(async (_request: StartRequest): Promise<unknown> => undefined);
  await act(async () => {
    root.render(<NewAgentPage agents={[agent('claude', 'Claude')]} panes={[]} needs={[]} api={pageApi(state)} addonApi={addonApi} onStart={onStart} onSignIn={vi.fn()} onOpenPane={vi.fn()} {...props} />);
  });
  await act(async () => {});
  return { onStart };
}
const openPlus = async () => act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Add to your message"]')!.click());
const copySwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby="na-copy-label"]')!;
async function send() {
  const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'fix the tests');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!.click());
}

describe('Work on a copy, for a chat on the New agent page', () => {
  it('is off by default and a chat starts in the folder itself', async () => {
    const { onStart } = await mount('repo');
    await openPlus();
    expect(host.querySelector('#na-copy-label')?.textContent).toBe('Work on a copy');
    expect(copySwitch().getAttribute('aria-checked')).toBe('false');
    expect(copySwitch().disabled).toBe(false);
    await act(async () => copySwitch().click()); // on...
    await act(async () => copySwitch().click()); // ...and off again
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ runAs: 'chat', isolated: false });
  });

  it('turned on, it reaches the start request, and the choice is remembered for the project', async () => {
    const first = await mount('repo');
    await openPlus();
    await act(async () => copySwitch().click());
    expect(copySwitch().getAttribute('aria-checked')).toBe('true');
    await send();
    expect(first.onStart.mock.calls[0][0]).toMatchObject({ runAs: 'chat', isolated: true });

    // A new page (a new visit): the switch is already on for this project.
    await act(async () => root.unmount());
    root = createRoot(host);
    const again = await mount('repo');
    await openPlus();
    expect(copySwitch().getAttribute('aria-checked')).toBe('true');
    await send();
    expect(again.onStart.mock.calls[0][0]).toMatchObject({ isolated: true });
  });

  it('a folder without Git is offered a plain trial copy, and says so', async () => {
    const { onStart } = await mount('folder');
    await openPlus();
    expect(copySwitch().disabled).toBe(false);
    expect(host.textContent).toContain('plain trial copy');
    await act(async () => copySwitch().click());
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ runAs: 'chat', isolated: true });
  });

});

describe('which folders a chat can copy', () => {
  it('any folder that exists: Git with a first commit, no commits yet, or no Git at all; not a folder that is gone', async () => {
    const { supportsChatCopy, isPlainCopyFolder } = await import('../../../lib/ship-model');
    expect(['repo', 'no_commits', 'folder', undefined].map((s) => supportsChatCopy(s as GitState | undefined))).toEqual([true, true, true, true]);
    expect(supportsChatCopy('missing')).toBe(false);
    expect(['repo', 'no_commits', 'folder'].map((s) => isPlainCopyFolder(s as GitState))).toEqual([false, true, true]);
  });
});
