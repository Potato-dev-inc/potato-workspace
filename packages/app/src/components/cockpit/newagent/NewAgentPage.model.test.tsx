// @vitest-environment jsdom
// The model picker on the New agent page: drawn for an agent that can start on a model, hidden for one that cannot,
// its choice goes out with the start request, and the last choice is remembered per agent (and sign-in).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
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

const OPTIONS: Record<string, ModelOptions> = {
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] },
  beta: { terminal: false, defaultModel: null, models: [] },
};
const modelApi: ModelOptionsApi = { get: vi.fn(async (id: string) => OPTIONS[id]) };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(lanes: 'chat' | 'terminal', onStart = vi.fn(async (_r: StartRequest) => undefined), agents = [agent('alpha', 'Alpha'), agent('beta', 'Beta')]) {
  await act(async () => {
    root.render(<NewAgentPage agents={agents} panes={[]} needs={[]} api={api(lanes)} modelApi={modelApi} onStart={onStart} onOpenPane={() => undefined} />);
  });
  await act(async () => {});
  return onStart;
}

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="na-model"]');
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const option = (text: string) => [...host.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.includes(text));
async function send(text = 'fix it') {
  const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(host.querySelector('button[aria-label="Send"]'));
}

describe('New agent page: model picker', () => {
  it('shows for an agent with models, with Default naming the default model', async () => {
    await mount('terminal');
    expect(chip()?.textContent).toContain('Default (gpt-5.1)');
    await click(chip());
    expect([...host.querySelectorAll('[role=option]')].map((o) => o.textContent)).toEqual(['Defaultgpt-5.1', 'gpt-5.1', 'gpt-5-mini']);
  });

  it('is hidden for an agent that cannot take a model when it starts', async () => {
    await mount('terminal', undefined, [agent('beta', 'Beta')]);
    expect(chip()).toBeNull();
  });

  it('a chat always offers it, with a typed id when the agent lists none', async () => {
    await mount('chat', undefined, [agent('beta', 'Beta')]);
    expect(chip()).not.toBeNull();
    await click(chip());
    expect(host.querySelector('input[aria-label="Type a model id"]')).not.toBeNull();
  });

  it('with Default picked, the start request carries no model', async () => {
    const onStart = await mount('terminal');
    await send();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect('model' in onStart.mock.calls[0][0]).toBe(false);
  });

  it('a terminal start carries the picked model', async () => {
    const onStart = await mount('terminal');
    await click(chip());
    await click(option('gpt-5-mini'));
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ agentId: 'alpha', runAs: 'terminal', model: 'gpt-5-mini' });
  });

  it('a chat start carries the picked model', async () => {
    const onStart = await mount('chat');
    await click(chip());
    await click(option('gpt-5-mini'));
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ agentId: 'alpha', runAs: 'chat', model: 'gpt-5-mini' });
  });

  it('remembers the last choice for the agent and pre-selects it next time', async () => {
    await mount('terminal');
    await click(chip());
    await click(option('gpt-5-mini'));
    await act(async () => root.unmount());
    root = createRoot(host);
    const onStart = await mount('terminal');
    expect(chip()?.textContent).toContain('gpt-5-mini');
    await send();
    expect(onStart.mock.calls[0][0].model).toBe('gpt-5-mini');
  });

  it('choosing Default again forgets the remembered model', async () => {
    await mount('terminal');
    await click(chip());
    await click(option('gpt-5-mini'));
    await click(chip());
    await click(option('Default'));
    expect(localStorage.getItem('pm.newagent.model.alpha')).toBeNull();
    expect(chip()?.textContent).toContain('Default (gpt-5.1)');
  });
});
