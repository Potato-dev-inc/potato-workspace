// @vitest-environment jsdom
// The New agent box: a huge paste is refused with a sentence, and files dropped from Explorer become paths in the message.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi, AddonStatus } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { setCopyOfferGlobal, setProjectOffer } from '../../../lib/copyOffer';
import { writeCopyPreference } from '../../../lib/ship-model';
import { forceShowTerminals } from '../../../lib/showTerminals';
import type { GitState, RecentProject } from '../../../lib/ship-api';
import type { NewAgentApi } from './api';
import type { LaneView, StartRequest } from './model';
import { NewAgentPage, type NewAgentPageProps } from './NewAgentPage';
import { PASTE_MAX_CHARS } from '../../../lib/bigText';
import { setFileDropSource, type WindowDropEvent } from '../../../lib/fileDrop';

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
  setCopyOfferGlobal(true);
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
const openPlus = async () => act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Add to your message"]')!.click());
const copySwitch = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-labelledby="na-copy-label"]')!;
async function send() {
  const box = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'fix the tests');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!.click());
}


describe('the New agent box', () => {
  it('refuses a huge paste with a sentence and leaves the box alone', async () => {
    await mount('repo');
    const box = document.querySelector<HTMLTextAreaElement>('textarea')!;
    const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { files: [], getData: () => 'x'.repeat(PASTE_MAX_CHARS + 1) };
    await act(async () => {
      box.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-testid="na-paste-note"]')).not.toBeNull();
    expect(box.value).toBe('');
  });

  it('turns files dropped from Explorer into paths in the message', async () => {
    let cb: ((e: WindowDropEvent) => void) | null = null;
    setFileDropSource(async (c) => {
      cb = c;
      return () => undefined;
    });
    await mount('repo');
    await act(async () => {});
    cb!({ type: 'drop', paths: ['/work/notes.txt'], position: { x: 0, y: 0 } });
    // jsdom has no layout: the rectangle is all zeros, so the pointer at 0,0 is inside it.
    await act(async () => {});
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toContain('/work/notes.txt');
    setFileDropSource(null);
  });
});
