// @vitest-environment jsdom
// The New agent page remembers its last five choices (Terminal or Chat, agent, sign-in, model, project) and starts on
// Chat by default. A remembered value that no longer exists falls back quietly to the normal default.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../../lib/accounts';
import type { AcpAddonApi } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
import type { RecentProject } from '../../../lib/ship-api';
import type { NewAgentApi } from './api';
import type { LaneView, StartRequest } from './model';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor =>
  ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;
const project = (name: string): RecentProject => ({ path: `/work/${name}`, name, state: 'repo', last_used_ms: 5 });

const LANES: LaneView = {
  labsEnabled: true,
  agents: [
    { id: 'alpha', lane: 'terminal', disabled: false },
    { id: 'beta', lane: 'terminal', disabled: false },
  ],
};
const OPTIONS: Record<string, ModelOptions> = {
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] },
  beta: { terminal: true, defaultModel: null, models: ['m1', 'm2'] },
};
const WORK: Account = { id: 'acc1', agent_id: 'beta', label: 'Work', home: '/h/work' };

interface Setup {
  lanes?: LaneView | null;
  accounts?: Account[];
  gitState?: Record<string, 'repo' | 'missing'>;
  /** Folders with a pane open in them: listed under "Running now" in the project picker. */
  running?: string[];
}

function apiFor(setup: Setup): NewAgentApi {
  return {
    recent: async () => [project('alpha-app'), project('beta-site')],
    pickFolder: async () => null,
    pickPaths: async () => [],
    defaultFolder: async () => null,
    gitState: async (path: string) => setup.gitState?.[path] ?? 'repo',
    lanes: async () => (setup.lanes === undefined ? LANES : setup.lanes),
    accounts: async () => setup.accounts ?? [],
    loadHome: async () => ({ name: '', cards: [] }),
    saveCards: async () => undefined,
    onHomeChanged: async () => () => undefined,
  };
}

const addonApi: AcpAddonApi = {
  list: async () => ({ labsEnabled: true, addons: [] }),
  install: async () => {
    throw new Error('not used');
  },
  remove: async () => {
    throw new Error('not used');
  },
  watch: async () => () => undefined,
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

async function mount(setup: Setup = {}, onStart = vi.fn(async (_r: StartRequest) => undefined)) {
  await act(async () => {
    root.render(
      <NewAgentPage
        agents={[agent('alpha', 'Alpha'), agent('beta', 'Beta')]}
        panes={[]}
        needs={[]}
        runningFolders={setup.running}
        api={apiFor(setup)}
        addonApi={addonApi}
        modelApi={modelApi}
        onStart={onStart}
        onOpenPane={() => undefined}
      />,
    );
  });
  await act(async () => {});
  await act(async () => {});
  return onStart;
}
async function remount(setup: Setup = {}) {
  await act(async () => root.unmount());
  root = createRoot(host);
  return mount(setup);
}

const chip = (id: string) => host.querySelector<HTMLElement>(`[data-testid="na-${id}"]`);
const runAs = (word: 'Terminal' | 'Chat') => [...host.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((b) => b.textContent === word);
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const menuItem = (text: string, role = 'menuitemradio') => [...host.querySelectorAll<HTMLElement>(`[role=${role}]`)].find((b) => b.textContent?.includes(text));
const option = (text: string) => [...host.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.includes(text));
async function send(text = 'fix it') {
  const area = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(host.querySelector('button[aria-label="Send"]'));
}

describe('New agent page: starts on Chat', () => {
  it('Chat is the default, even when the agent is saved to run in a terminal', async () => {
    await mount();
    expect(runAs('Chat')?.getAttribute('aria-checked')).toBe('true');
    expect(runAs('Terminal')?.getAttribute('aria-checked')).toBe('false');
  });

  it('an agent with no chat to start starts a terminal, with no switch shown', async () => {
    const onStart = await mount({ lanes: { labsEnabled: true, agents: [] } });
    expect(runAs('Chat')).toBeUndefined();
    await send();
    expect(onStart.mock.calls[0][0]).toMatchObject({ agentId: 'alpha', runAs: 'terminal' });
  });
});

describe('New agent page: remembers the last five choices', () => {
  it('reopening the page restores run as, agent with sign-in, model and project', async () => {
    const setup: Setup = { accounts: [WORK], running: ["/work/beta-site"] };
    await mount(setup);
    // Pick Beta under the Work sign-in, Terminal, a model and a project.
    await click(chip('agent'));
    await click(menuItem('Beta · Work'));
    await click(runAs('Terminal'));
    await click(chip('folder'));
    await click(menuItem("beta-site", "menuitem"));
    await click(chip('model'));
    await click(option('m2'));

    await remount(setup);
    expect(chip('agent')?.textContent).toContain('Beta · Work');
    expect(runAs('Terminal')?.getAttribute('aria-checked')).toBe('true');
    expect(chip('folder')?.textContent).toContain('beta-site');
    expect(chip('model')?.textContent).toContain('m2');
  });

  it('a Chat choice is remembered too, and a later Terminal choice replaces it', async () => {
    await mount();
    await click(runAs('Terminal'));
    await remount();
    expect(runAs('Terminal')?.getAttribute('aria-checked')).toBe('true');
    await click(runAs('Chat'));
    await remount();
    expect(runAs('Chat')?.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('pm.newagent.runAs')).toBe('chat');
  });

  it('a remembered agent that is no longer there falls back to the first ready agent', async () => {
    localStorage.setItem('pm.newagent.agent', 'removed-agent');
    await mount();
    expect(chip('agent')?.textContent).toContain('Alpha');
  });

  it('a remembered sign-in that was removed falls back to the normal default', async () => {
    localStorage.setItem('pm.newagent.agent', 'beta:gone-account');
    await mount({ accounts: [] });
    expect(chip('agent')?.textContent).toContain('Alpha');
    expect(chip('agent')?.textContent).not.toContain('·');
  });

  it('a remembered Terminal or Chat for an agent with no chat is quietly a terminal', async () => {
    localStorage.setItem('pm.newagent.runAs', 'chat');
    await mount({ lanes: { labsEnabled: true, agents: [{ id: 'beta', lane: 'terminal', disabled: false }] } });
    expect(chip('agent')?.textContent).toContain('Alpha');
    expect(runAs('Chat')).toBeUndefined();
  });

  it('a remembered project that is gone is skipped for the next one', async () => {
    localStorage.setItem('pm.newagent.lastProject', JSON.stringify({ path: '/work/old-app', name: 'old-app' }));
    await mount({ gitState: { '/work/old-app': 'missing' } });
    await act(async () => {});
    expect(chip('folder')?.textContent).not.toContain('old-app');
    expect(chip('folder')?.textContent).not.toContain('none chosen');
  });

  it('a remembered model the agent no longer lists shows the agent default', async () => {
    localStorage.setItem('pm.newagent.model.alpha', 'retired-model');
    await mount();
    expect(chip('model')?.textContent).toContain('Default (gpt-5.1)');
  });

  it('the agent choice is remembered as soon as it is picked, not only on send', async () => {
    await mount();
    await click(chip('agent'));
    await click(menuItem('Beta'));
    expect(localStorage.getItem('pm.newagent.agent')).toBe('beta');
  });
});
