// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { RecentProject } from '../../../lib/ship-api';
import { t } from '../../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../../i18n/test-utils';
import type { NewAgentApi } from './api';
import type { HomeCard, LaneView } from './model';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor =>
  ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true }, ...extra }) as unknown as AgentDescriptor;
const project = (name: string): RecentProject => ({ path: `/work/${name}`, name, state: 'repo', last_used_ms: 5 });

const CARDS: HomeCard[] = [
  { id: 'c1', kind: 'recent' },
  { id: 'c2', kind: 'running' },
  { id: 'c3', kind: 'needs' },
  { id: 'c4', kind: 'prompt', text: 'keep commits short' },
];

function makeApi(cards: HomeCard[], lanes: LaneView | null = null): NewAgentApi {
  return {
    recent: async () => [project('alpha-app'), project('beta-site')],
    pickFolder: async () => null,
    pickPaths: async () => [],
    defaultFolder: async () => null,
    gitState: async () => 'repo',
    lanes: async () => lanes,
    accounts: async () => [],
    loadHome: async () => ({ name: '', cards }),
    saveCards: vi.fn(async () => undefined),
    onHomeChanged: async () => () => undefined,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

const EXTRA = ['alpha-app', 'beta-site', 'Default', 'alpha', 'beta', 'gone', 'app', 'site', 'work', 'keep', 'commits', 'short', 'Alpha', 'Beta', 'Gone'];

async function mount(cards: HomeCard[], lanes: LaneView | null = null) {
  await act(async () => {
    root.render(
      <NewAgentPage
        agents={[agent('alpha', 'Alpha'), agent('beta', 'Beta'), agent('gone', 'Gone', { installed: false })]}
        panes={[{ id: 'p1', title: 'Alpha 1', status: 'running' }]}
        needs={[{ id: 'p3', title: 'Beta 2', status: 'waiting_input' }]}
        api={makeApi(cards, lanes)}
        onStart={vi.fn(async () => undefined)}
        onOpenPane={vi.fn()}
        onSetUp={vi.fn()}
      />,
    );
  });
  await act(async () => {});
}
const open = async (testId: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click());
};

describe('New agent page in Traditional Chinese', () => {
  it('shows the empty page with starters in Chinese', async () => {
    await mount([]);
    expect(host.querySelector('[data-testid="na-ask"]')?.textContent).toBe(t('newAgent.ask'));
    expect(host.textContent).toContain(t('newAgent.tryOne'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
  });

  it('shows every home card, the pickers and the plus menu in Chinese', async () => {
    await mount(CARDS, { labsEnabled: true, agents: [{ id: 'alpha', lane: 'terminal', disabled: false }] });
    expect(host.textContent).toContain(t('newAgent.cardRecent'));
    expect(host.textContent).toContain(t('newAgent.cardPrompt'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
    await open('na-plus');
    expect(host.textContent).toContain(t('newAgent.addFiles'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
    await open('na-folder');
    expect(host.textContent).toContain(t('newAgent.addProject'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
    await open('na-agent');
    expect(host.textContent).toContain(t('newAgent.setUpAgents'));
    expect(host.textContent).toContain(t('firstRun.agentMissing'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
  });
});
