// @vitest-environment jsdom
// Pins on the New agent page: what the person pinned for this agent in this project is shown under the message box,
// a pinned model starts the agent, and with nothing pinned the page draws nothing extra.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { NO_PINS, type EffectivePins } from '../../../lib/agentRules';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
import { useEnglish } from '../../../i18n/test-utils';
import type { NewAgentApi } from './api';
import type { StartRequest } from './model';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;

const api: NewAgentApi = {
  recent: async () => [{ path: '/work/app', name: 'app', state: 'repo', last_used_ms: 5 }],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => ({ labsEnabled: true, agents: [{ id: 'alpha', lane: 'acp', disabled: false }] }),
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
};
const options: Record<string, ModelOptions> = { alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] } };
const modelApi: ModelOptionsApi = { get: vi.fn(async (id: string) => options[id]) };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(pins: EffectivePins, onStart = vi.fn(async (_r: StartRequest) => undefined)) {
  const effective = vi.fn(async () => pins);
  await act(async () => {
    root.render(
      <NewAgentPage agents={[agent('alpha', 'Alpha')]} panes={[]} needs={[]} api={api} modelApi={modelApi} defaultsApi={{ get: async () => ({}) }} rulesApi={{ effective }} onStart={onStart} onOpenPane={() => undefined} />,
    );
  });
  await act(async () => {});
  await act(async () => {});
  return { onStart, effective };
}
const line = () => document.querySelector('[data-testid="na-pinned"]');
async function send() {
  const area = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'fix it');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!.click());
}

describe('New agent page: pins', () => {
  it('draws nothing when nothing is pinned', async () => {
    await mount(NO_PINS);
    expect(line()).toBeNull();
  });

  it('shows the pinned model, mode, Force yes, fences and notes, asked for this agent and project', async () => {
    const { effective } = await mount({ model: 'gpt-5-mini', mode: 'plan', force_yes: true, force_yes_source: 'pin', notes: 'Run the tests first.', fences: ['secrets', 'config/prod.yml'] });
    expect(effective).toHaveBeenCalledWith('alpha', '/work/app');
    const text = line()?.textContent ?? '';
    expect(text).toContain('Pinned for new agents');
    expect(text).toContain('Model gpt-5-mini');
    expect(text).toContain('Mode plan');
    expect(text).toContain('Force yes on');
    expect(text).toContain('2 fences');
    expect(text).toContain('Notes');
  });

  it('says 1 fence for one, and the change link opens Settings on the rules row', async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ tab: string }>).detail.tab);
    window.addEventListener('pm:open-settings', listener);
    await mount({ ...NO_PINS, fences: ['secrets'] });
    expect(line()?.textContent).toContain('1 fence');
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="na-pinned-change"]')!.click());
    window.removeEventListener('pm:open-settings', listener);
    expect(seen).toContain('agent-rules');
  });

  it('a pinned model is the model the agent starts on', async () => {
    const { onStart } = await mount({ ...NO_PINS, model: 'gpt-5-mini' });
    await send();
    expect(onStart.mock.calls[0][0].model).toBe('gpt-5-mini');
  });
});
