// @vitest-environment jsdom
// Screen level: the New agent page's menus close on an outside press, Escape, focus leaving and page scroll, through
// the shared closing rule (hooks/useDismissable).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import type { ModelOptions, ModelOptionsApi } from '../../../lib/modelOptions';
import type { NewAgentApi } from './api';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, label: string): AgentDescriptor => ({ id, label, kind: 'cli', installed: true, modes: { headless: true, visible: true } }) as unknown as AgentDescriptor;
const api: NewAgentApi = {
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
};
const OPTIONS: Record<string, ModelOptions> = {
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] },
  beta: { terminal: false, defaultModel: null, models: [] },
};
const modelApi: ModelOptionsApi = { get: vi.fn(async (id: string) => OPTIONS[id]) };

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<NewAgentPage agents={[agent('alpha', 'Alpha'), agent('beta', 'Beta')]} panes={[]} needs={[]} api={api} modelApi={modelApi} defaultsApi={{ get: async () => ({}) }} onStart={async () => undefined} onOpenPane={() => undefined} />);
  });
  await act(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const click = async (el: Element | null) => {
  if (!el) throw new Error('element not found');
  await act(async () => (el as HTMLElement).click());
};
const optionsShown = () => document.querySelectorAll('[role=option]').length > 0;

describe('New agent page menus close like every other dropdown', () => {
  const openModelMenu = async () => {
    await click(document.querySelector('[data-testid="na-model"]'));
    expect(optionsShown()).toBe(true);
  };

  it('closes on a press outside, even when the page stops the event', async () => {
    await openModelMenu();
    const outside = document.createElement('div');
    outside.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(optionsShown()).toBe(false);
    outside.remove();
  });

  it('closes on Escape', async () => {
    await openModelMenu();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(optionsShown()).toBe(false);
  });

  it('closes when focus leaves it', async () => {
    await openModelMenu();
    const input = document.createElement('input');
    document.body.appendChild(input);
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(optionsShown()).toBe(false);
    input.remove();
  });

  it('closes when the page scrolls', async () => {
    await openModelMenu();
    await act(async () => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(optionsShown()).toBe(false);
  });
});
