// @vitest-environment jsdom
// The Getting started card is on the New agent page (it would ship invisible otherwise): below the box, above the
// pinned cards, with "Start one" taking the person to the message box.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { hideGettingStarted, markStep, resetGettingStarted, seedSteps } from '../../../lib/getting-started';
import type { NewAgentApi } from './api';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [{ id: 'claude', label: 'Claude', kind: 'cli', installed: true, modes: { headless: true, visible: true } }] as unknown as AgentDescriptor[];
const addonApi: AcpAddonApi = { list: async () => ({ labsEnabled: true, addons: [] }), install: vi.fn(), remove: vi.fn(), watch: async () => () => undefined } as unknown as AcpAddonApi;
const pageApi = (): NewAgentApi => ({
  recent: async () => [],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => ({ labsEnabled: true, agents: [{ id: 'claude', lane: 'terminal', disabled: false }] }),
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [{ id: 'c1', kind: 'recent' }] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetGettingStarted();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(paneCount = 1) {
  const panes = Array.from({ length: paneCount }, (_, i) => ({ id: `p${i}`, title: `Agent ${i}`, status: 'idle' }));
  await act(async () => {
    root.render(<NewAgentPage agents={agents} panes={panes} needs={[]} api={pageApi()} addonApi={addonApi} onStart={vi.fn(async () => undefined)} onSignIn={vi.fn()} onOpenPane={vi.fn()} />);
  });
  await act(async () => {});
}
const card = () => host.querySelector<HTMLElement>('[data-testid="getting-started"]');

describe('the New agent page shows Getting started', () => {
  it('after the first look: "Getting started · 1 of 6", above the pinned cards', async () => {
    seedSteps(['second']);
    await mount(2);
    expect(card()!.textContent).toContain('Getting started · 1 of 6');
    const cards = host.querySelector('.ck-na-cards')!;
    expect(card()!.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('"Start one" puts the cursor in the message box', async () => {
    seedSteps([]);
    await mount(1);
    const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => card()!.querySelector<HTMLButtonElement>('[data-step="second"] button')!.click());
    expect(document.activeElement).toBe(box);
  });

  it('ticks while the page is open, and Hide takes it away', async () => {
    seedSteps([]);
    await mount(1);
    await act(async () => markStep('limit'));
    expect(card()!.textContent).toContain('1 of 6');
    await act(async () => hideGettingStarted());
    expect(card()).toBeNull();
  });
});
