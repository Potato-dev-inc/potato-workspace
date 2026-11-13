// @vitest-environment jsdom
// The model picker on the New agent page shows the agent's own live list (the one the chat picker shows).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
import type { NewAgentApi } from './api';
import type { StartRequest } from './model';
import { NewAgentPage } from './NewAgentPage';
import { setChatModelOn } from './start';
import { optionsFromWire } from '../../../lib/modelOptions';
import type { AcpChatApi, AcpChatState } from '../../../lib/acpChat';

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


const LIVE_OPTION = {
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default',
  options: [
    { value: 'default', name: 'Default (recommended) · Opus 5.5', description: 'Best for most work' },
    { value: 'opus', name: 'Opus 5.5', description: 'Most capable' },
    { value: 'fable', name: 'Fable 5.2', description: 'Fast and light' },
    { value: 'haiku', name: 'Haiku 5.5', description: null },
  ],
};
const wire = (live: unknown) => ({ terminal: true, default_model: null, models: ['opus', 'sonnet', 'haiku'], live });
let modelApi: ModelOptionsApi;
let resolveGet: ((o: ModelOptions) => void) | null = null;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resolveGet = null;
  modelApi = { get: vi.fn(async () => optionsFromWire(wire(LIVE_OPTION))) };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(onStart = vi.fn(async (_r: StartRequest) => undefined)) {
  await act(async () => {
    root.render(<NewAgentPage agents={[agent('alpha', 'Alpha')]} panes={[]} needs={[]} api={api('chat')} modelApi={modelApi} defaultsApi={{ get: async () => ({}) }} onStart={onStart} onOpenPane={() => undefined} />);
  });
  await act(async () => {});
  return onStart;
}

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="na-model"]');
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const rows = () => [...document.querySelectorAll('[role=option]')].map((o) => o.textContent);
const option = (text: string) => [...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.includes(text));
async function send(text = 'fix it') {
  const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(host.querySelector('button[aria-label="Send"]'));
}

describe("New agent page: the agent's live models", () => {
  it("new agent picker shows the agent's live models with descriptions", async () => {
    await mount();
    expect(chip()?.textContent).toContain('Default (recommended) · Opus 5.5');
    await click(chip());
    expect(rows()).toEqual([
      'Default (recommended) · Opus 5.5Best for most work',
      'Opus 5.5Most capable',
      'Fable 5.2Fast and light',
      'Haiku 5.5',
    ]);
  });

  it('new agent picker shows the cached list while loading', async () => {
    localStorage.setItem('pm.agent.models.live.alpha', JSON.stringify(wire(LIVE_OPTION)));
    modelApi = { get: vi.fn(() => new Promise<ModelOptions>((r) => { resolveGet = r; })) };
    await mount();
    await click(chip());
    expect(rows()).toContain('Fable 5.2Fast and light');
    expect(document.body.textContent).not.toContain('Loading models');
    expect(resolveGet).not.toBeNull();
  });

  it('picking a model on the new agent page starts the chat on that model', async () => {
    const onStart = await mount();
    await click(chip());
    await click(option('Fable 5.2'));
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ agentId: 'alpha', runAs: 'chat', model: 'fable' });
    // The start then sets it exactly the way the chat picker does: the chip's own option id and value.
    const state = { configOptions: [LIVE_OPTION] } as unknown as AcpChatState;
    const setConfig = vi.fn(async () => state);
    const problem = await setChatModelOn('p1', 'fable', { state: async () => state, setConfig } as unknown as Pick<AcpChatApi, 'state' | 'setConfig'>, async () => undefined);
    expect(problem).toBeNull();
    expect(setConfig).toHaveBeenCalledWith('p1', 'model', 'fable');
  });

  it('falls back to preset names plus typed id when the agent never reported models', async () => {
    modelApi = { get: vi.fn(async () => optionsFromWire(wire(null))) };
    await mount();
    await click(chip());
    expect(rows()).toEqual(['Default', 'Opus', 'Sonnet', 'Haiku']);
    expect(document.querySelector('input[aria-label="Search models"]')).not.toBeNull();
  });
});
