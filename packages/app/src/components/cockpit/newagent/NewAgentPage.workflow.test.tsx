// @vitest-environment jsdom
// Labs "Workflows" on the New agent page: the Workflow dropdown shows only while the switch is on; a picked workflow locks
// the agent and model pickers (they stay on the page) and says what it will start in one read-only line with an
// "Edit workflow" link; Start sends the front's agent and model with the front's brief first and the person's words last;
// whole-horde mode also starts the helpers under the front's pane. With the switch off the page is as it was.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
import { registerSettingsOpener } from '../../../lib/openSettingsAt';
import type { NewAgentApi, WorkflowChoice } from './api';
import type { StartRequest } from './model';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;

const plan = (start_mode: string, reply_style = 'translator'): WorkflowChoice['plan'] => ({
  name: 'Haiku router',
  front_name: 'Front',
  front_agent: 'beta',
  front_model: 'haiku',
  helpers: [
    { name: 'Hard', agent_type: 'alpha', model: 'sonnet', when_to_use: 'hard tasks', kind: 'minion' },
    { name: 'Easy', agent_type: 'alpha', model: 'deepseek', when_to_use: 'easy tasks', kind: 'minion' },
  ],
  start_mode,
  helper_cap: 3,
  reply_style,
  brief: 'You are the front of the workflow "Haiku router".\n',
  first_message: 'You are the front of the workflow "Haiku router".\nThe person\'s request:\nfix login',
});

let workflows: WorkflowChoice[] | null;
const planFor = vi.fn(async (_slug: string, _folder: string, _request: string) => plan('front'));
const helpers = vi.fn(async (_slug: string, _folder: string, _pane: string): Promise<string | null> => null);

const api = (): NewAgentApi => ({
  recent: async () => [{ path: '/work/app', name: 'app', state: 'repo', last_used_ms: 5 }],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => ({ labsEnabled: true, agents: [{ id: 'alpha', lane: 'acp', disabled: false }, { id: 'beta', lane: 'acp', disabled: false }] }),
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
  workflows: async () => workflows,
  workflowPlan: planFor,
  workflowHelpers: helpers,
});

const OPTIONS: Record<string, ModelOptions> = {
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1'] },
  beta: { terminal: true, defaultModel: null, models: ['haiku', 'sonnet'] },
};
const modelApi: ModelOptionsApi = { get: vi.fn(async (id: string) => OPTIONS[id]) };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  planFor.mockClear();
  helpers.mockClear();
  workflows = [{ slug: 'haiku-router', plan: plan('front') }];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  registerSettingsOpener(null);
  await act(async () => root.unmount());
  host.remove();
});

async function mount(onStart: (r: StartRequest) => Promise<unknown> = vi.fn(async () => 'pane-front')) {
  await act(async () => {
    root.render(<NewAgentPage agents={[agent('alpha', 'Alpha'), agent('beta', 'Beta')]} panes={[]} needs={[]} api={api()} modelApi={modelApi} defaultsApi={{ get: async () => ({}) }} onStart={onStart} onOpenPane={() => undefined} />);
  });
  await act(async () => {});
  return onStart as ReturnType<typeof vi.fn>;
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const pick = async (name: string) => {
  await click(byId('na-workflow'));
  await click([...document.querySelectorAll<HTMLElement>('[role=menuitemradio]')].find((o) => o.textContent === name));
};
async function send(text = 'fix login') {
  const area = document.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(document.querySelector('button[aria-label="Start"]'));
}

describe('New agent page: Workflow dropdown', () => {
  it('is not drawn while the Labs switch is off', async () => {
    workflows = null;
    await mount();
    expect(byId('na-workflow')).toBeNull();
    expect(byId('na-agent')).not.toBeNull();
  });

  it('locks the agent and model pickers and shows the summary line when a workflow is picked', async () => {
    await mount();
    expect(byId('na-agent')).not.toBeNull();
    await pick('Haiku router');
    expect(byId('na-agent')).toBeNull();
    expect(byId('na-model')).toBeNull();
    const agentChip = byId('na-agent-locked') as HTMLButtonElement;
    const modelChip = byId('na-model-locked') as HTMLButtonElement;
    expect(agentChip.disabled && modelChip.disabled).toBe(true);
    expect(agentChip.textContent).toContain('Beta');
    expect(modelChip.textContent).toContain('Haiku');
    expect(byId('na-wf-summary')!.textContent).toContain('Front: Haiku. Others: Sonnet (hard tasks, minion), DeepSeek (easy tasks, minion).');
    expect(byId('na-wf-summary')!.textContent).toContain('The front retells results in its own words.');
    expect(document.querySelector('[data-testid="na-folder"]')).not.toBeNull(); // the folder picker stays
    await pick('No workflow');
    expect(byId('na-agent')).not.toBeNull();
    expect(byId('na-wf-summary')).toBeNull();
  });

  it('"Edit workflow" opens the Crews page in Settings', async () => {
    const opened = vi.fn();
    registerSettingsOpener(opened);
    await mount();
    await pick('Haiku router');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit workflow'));
    expect(opened).toHaveBeenCalledWith('crews');
  });

  it('starts the front with the brief first and the request last, and starts no helpers by itself', async () => {
    const onStart = await mount();
    await pick('Haiku router');
    await send('fix login');
    expect(planFor).toHaveBeenCalledWith('haiku-router', '/work/app', 'fix login');
    const request = onStart.mock.calls[0][0] as StartRequest;
    expect(request).toMatchObject({ agentId: 'beta', model: 'haiku', folder: '/work/app' });
    expect(request.prompt).toMatch(/^You are the front of the workflow/);
    expect(request.prompt).toMatch(/The person's request:\nfix login$/);
    expect(helpers).not.toHaveBeenCalled();
  });

  it('whole-horde mode starts the helpers under the front after it starts', async () => {
    workflows = [{ slug: 'haiku-router', plan: plan('horde') }];
    planFor.mockResolvedValueOnce(plan('horde'));
    await mount();
    await pick('Haiku router');
    expect(byId('na-wf-summary')!.textContent).toContain('Starts all the others now.');
    await send();
    expect(helpers).toHaveBeenCalledWith('haiku-router', '/work/app', 'pane-front');
  });

  it('the Router reply style is named in the line', async () => {
    workflows = [{ slug: 'haiku-router', plan: plan('front', 'router') }];
    await mount();
    await pick('Haiku router');
    expect(byId('na-wf-summary')!.textContent).toContain("The front shows each agent's own words.");
  });
});
