// @vitest-environment jsdom
// The model picker on the New agent page, the FIRST time for a chat agent nobody has chatted with: the page asks the app
// (`agent_model_options`, which reads the list with a short probe session), shows "Loading models", then the agent's own
// list. A failed read leaves Default and a quiet line. Uses the real command wrapper over a mocked `invoke`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { clearModelOptionsCache, tauriModelOptionsApi } from '../../../lib/modelOptions';
import type { NewAgentApi } from './api';
import type { StartRequest } from './model';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;

const api = (lanes: 'chat' | 'terminal'): NewAgentApi => ({
  recent: async () => [{ path: '/work/app', name: 'app', state: 'repo', last_used_ms: 5 }],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => (lanes === 'chat' ? { labsEnabled: true, agents: [{ id: 'alpha', lane: 'acp', disabled: false }, { id: 'beta', lane: 'acp', disabled: false }] } : null),
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
});


let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  clearModelOptionsCache();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const WIRE = {
  terminal: false,
  default_model: null,
  models: [],
  live: { id: 'model', category: 'model', type: 'select', options: [{ value: 'default', name: 'Default (recommended)', description: 'Use the default' }, { value: 'flash', name: 'Gemini Flash', description: 'Fast' }, { value: 'pro', name: 'Gemini Pro', description: null }] },
};

async function mount(onStart = vi.fn(async (_r: StartRequest) => undefined)) {
  await act(async () => {
    root.render(<NewAgentPage agents={[agent('alpha', 'Alpha')]} panes={[]} needs={[]} api={api('chat')} modelApi={tauriModelOptionsApi} defaultsApi={{ get: async () => ({}) }} onStart={onStart} onOpenPane={() => undefined} />);
  });
  await act(async () => {});
  return onStart;
}

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="na-model"]');
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const options = () => [...document.querySelectorAll<HTMLElement>('[role=option]')];

describe("New agent page: first look at a chat agent's models", () => {
  it("shows Loading models while the app reads the list, then the agent's own models (first open, nothing cached)", async () => {
    let finish: (w: unknown) => void = () => undefined;
    invoke.mockImplementation((cmd: string) => (cmd === 'agent_model_options' ? new Promise((r) => (finish = r)) : Promise.resolve(null)));
    await mount();
    await click(chip());
    expect(document.body.textContent).toContain('Loading models');
    expect(options().map((o) => o.textContent)).toEqual(['Default']);
    await act(async () => finish(WIRE));
    expect(options().map((o) => o.textContent)).toEqual(['Default (recommended)Use the default', 'Gemini FlashFast', 'Gemini Pro']);
    expect(document.body.textContent).not.toContain('Loading models');
  });

  it('picking a model from the first list starts the chat on it', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'agent_model_options' ? WIRE : null));
    const onStart = await mount();
    await click(chip());
    await click(options().find((o) => o.textContent?.includes('Gemini Flash')));
    const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'hi');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(host.querySelector('button[aria-label="Start"]'));
    expect(onStart.mock.calls[0][0]).toMatchObject({ model: 'flash' });
  });

  it('when the list cannot be read it keeps Default and says so quietly', async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === 'agent_model_options' ? { terminal: false, default_model: null, models: [], live: null, live_failed: true } : null));
    await mount();
    await click(chip());
    expect(options().map((o) => o.textContent)).toEqual(['Default']);
    expect(document.body.textContent).toContain("Couldn't read this agent's models");
  });
});
