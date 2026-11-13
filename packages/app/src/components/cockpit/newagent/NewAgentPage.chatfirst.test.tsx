// @vitest-environment jsdom
// The New agent page with "Show terminals" OFF: no Chat | Terminal switch, only agents that can chat, one quiet line for the
// rest, and Send starts a chat. With it ON the page is as before (the other NewAgentPage tests run with it on).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi, AddonStatus } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { forceShowTerminals } from '../../../lib/showTerminals';
import type { RecentProject } from '../../../lib/ship-api';
import type { NewAgentApi } from './api';
import type { LaneView, StartRequest } from './model';
import { NewAgentPage, type NewAgentPageProps } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;
const project: RecentProject = { path: '/work/alpha-app', name: 'alpha-app', state: 'repo', last_used_ms: 5 };
// Claude and Codex can chat; Aider cannot (no chat definition); Kilo's chat is switched off.
const lanes: LaneView = {
  labsEnabled: true,
  agents: [
    { id: 'claude', lane: 'terminal', disabled: false },
    { id: 'codex', lane: 'terminal', disabled: false },
    { id: 'kilo', lane: 'terminal', disabled: true },
  ],
};
const agents = [agent('claude', 'Claude'), agent('codex', 'Codex'), agent('aider', 'Aider'), agent('kilo', 'Kilo')];

const installed = (id: string): AddonStatus => ({ agent: id, label: id, state: 'installed', version: '1', pinned_version: '1', detail: '', size_mb: 1, lines: [], signin_hint: '' });
const addonApi: AcpAddonApi = {
  list: async () => ({ labsEnabled: true, addons: [installed('claude'), installed('codex')] }),
  install: vi.fn(async (id: string) => installed(id)),
  remove: vi.fn(async (id: string) => installed(id)),
  watch: async () => () => undefined,
};

function pageApi(): NewAgentApi {
  return {
    recent: async () => [project],
    pickFolder: async () => null,
    pickPaths: async () => [],
    defaultFolder: async () => null,
    gitState: async () => 'repo',
    lanes: async () => lanes,
    accounts: async () => [],
    loadHome: async () => ({ name: '', cards: [] }),
    saveCards: async () => undefined,
    onHomeChanged: async () => () => undefined,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
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

async function mount(props: Partial<NewAgentPageProps> = {}) {
  const onStart = vi.fn(async (_request: StartRequest): Promise<unknown> => undefined);
  await act(async () => {
    root.render(<NewAgentPage agents={agents} panes={[]} needs={[]} api={pageApi()} addonApi={addonApi} onStart={onStart} onSignIn={vi.fn()} onOpenPane={vi.fn()} {...props} />);
  });
  await act(async () => {});
  return { onStart };
}
const switchGroup = () => host.querySelector('[role="radiogroup"]');
const agentButton = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Agent:"]')!;
async function openAgents() {
  await act(async () => agentButton().click());
}
const menuLabels = () => [...host.querySelectorAll('[role="menuitemradio"]')].map((b) => b.textContent ?? '');

describe('the New agent page with terminals hidden', () => {
  it('draws no Chat | Terminal switch, lists only agents that can chat, and says how many need terminals', async () => {
    forceShowTerminals(false);
    await mount();
    expect(switchGroup()).toBeNull();
    await openAgents();
    const labels = menuLabels();
    expect(labels.some((l) => l.includes('Claude'))).toBe(true);
    expect(labels.some((l) => l.includes('Codex'))).toBe(true);
    expect(labels.some((l) => l.includes('Aider'))).toBe(false);
    expect(labels.some((l) => l.includes('Kilo'))).toBe(false);
    expect(host.querySelector('[data-testid="need-terminals"]')?.textContent).toContain('2 agents need terminals');
    expect(host.querySelector('[data-testid="need-terminals"]')?.textContent).toContain('Show terminals');
  });

  it('Send starts a chat', async () => {
    forceShowTerminals(false);
    const { onStart } = await mount();
    const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'fix the tests');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!.click());
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0][0]).toMatchObject({ runAs: 'chat', agentId: 'claude', isolated: false });
  });

  it('a remembered Terminal pick is ignored while terminals are hidden', async () => {
    localStorage.setItem('pm.newagent.runAs', 'terminal');
    forceShowTerminals(false);
    const { onStart } = await mount();
    const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'go');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!.click());
    expect(onStart.mock.calls[0][0]).toMatchObject({ runAs: 'chat' });
  });

  it('with terminals shown the page is as before: the switch, and every agent', async () => {
    forceShowTerminals(true);
    await mount();
    expect(switchGroup()).not.toBeNull();
    await openAgents();
    expect(menuLabels().some((l) => l.includes('Aider'))).toBe(true);
    expect(host.querySelector('[data-testid="need-terminals"]')).toBeNull();
  });

  it('Chat is the default even before its add-on is there, while terminals are shown', async () => {
    forceShowTerminals(true);
    const missing: AcpAddonApi = { ...addonApi, list: async () => ({ labsEnabled: true, addons: [{ ...installed('claude'), state: 'not_installed' }] }) };
    await mount({ addonApi: missing });
    const chat = [...host.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === 'Chat')!;
    expect(chat.getAttribute('aria-checked')).toBe('true');
  });
});
