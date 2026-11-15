// @vitest-environment jsdom
// The "Add a helper" popover: Agent + Model + Enter is enough, a role is optional, "Same as before" is one click, the limit
// is said in words, and only installed agents are offered. Opened the way the sidebar and What's new open it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StandbyHelpersApi, StandbyHelpersView } from '../../lib/standbyHelpers';
import { openNewStandby } from '../../lib/standbyHelpers';
import { runAction } from '../../whatsnew/registry';
import { AddHelperPopover, HELPER_RECENT_KEY } from './AddHelperPopover';

vi.mock('../../lib/agentRegistry', () => ({
  useAgentRegistry: () => ({
    source: 'registry',
    dispatchable_ids: [],
    agents: [
      { id: 'claude', label: 'Claude', kind: 'cli', installed: true },
      { id: 'codex', label: 'Codex', kind: 'cli', installed: true },
      { id: 'gemini', label: 'Gemini', kind: 'cli', installed: false },
      { id: 'bash', label: 'Bash', kind: 'shell', installed: true },
    ],
  }),
}));
vi.mock('../../lib/modelOptions', async (orig) => ({ ...(await orig<typeof import('../../lib/modelOptions')>()), useModelOptions: () => ({ status: 'ready', options: { terminal: false, defaultModel: null, models: ['gpt-5'], live: null, presetModels: ['gpt-5'] } }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const view = (n: number, max = 4): StandbyHelpersView => ({
  max, idle_minutes: 30,
  helpers: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `H${i}`, agent: 'codex', model: null, project: 'C:/p', after_task: 'wait', state: 'ready', note: null, pane_id: null, home: null, used_by: null, taken_over: false, open_pane: null, person_pane: null })),
});
const mkApi = (v: StandbyHelpersView) => ({ get: vi.fn(async () => v), add: vi.fn(async () => v) }) as unknown as StandbyHelpersApi & { add: ReturnType<typeof vi.fn> };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const pop = () => document.querySelector<HTMLFormElement>('[data-testid="add-helper"]');

async function open(api: StandbyHelpersApi, front: { id: string; cwd: string | null; agent: string } | null = { id: 'a1', cwd: 'C:/p', agent: 'claude' }) {
  await act(async () => root.render(<AddHelperPopover api={api} front={front} homeLabel={() => 'Right panel rebuild'} />));
  await act(async () => openNewStandby('C:/p', 'a1', { x: 20, y: 20 }));
  await flush();
}

describe('Add a helper popover', () => {
  it('opens with no role chosen, the agent in front picked, and Add focused; Enter alone adds "<Agent>"', async () => {
    const api = mkApi(view(0));
    await open(api);
    expect(pop()!.textContent).toContain('Right panel rebuild');
    expect(pop()!.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(pop()!.querySelector('[aria-checked="true"]')!.textContent).toBe('Claude');
    expect(document.activeElement!.getAttribute('data-testid')).toBe('add-helper-add');
    await act(async () => pop()!.requestSubmit());
    await flush();
    expect(api.add).toHaveBeenCalledWith({ name: 'Claude', agent: 'claude', model: null, project: 'C:/p', after_task: 'wait', home: 'a1' });
    expect(pop()).toBeNull();
  });

  it('a role is optional: choosing one only gives the name, a typed name wins', async () => {
    const api = mkApi(view(0));
    await open(api);
    await act(async () => [...pop()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Reviewer')!.click());
    await act(async () => pop()!.requestSubmit());
    await flush();
    expect(api.add.mock.calls[0][0]).toMatchObject({ name: 'Reviewer', agent: 'claude' });
  });

  it('picking another agent changes what it adds', async () => {
    const api = mkApi(view(0));
    await open(api);
    await act(async () => [...pop()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === 'Codex')!.click());
    await act(async () => pop()!.requestSubmit());
    await flush();
    expect(api.add.mock.calls[0][0]).toMatchObject({ name: 'Codex', agent: 'codex' });
  });

  it('lists only installed agents that are not a plain shell', async () => {
    await open(mkApi(view(0)));
    expect([...pop()!.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['Claude', 'Codex']);
  });

  it('"Same as before": the last two helpers are one click each', async () => {
    localStorage.setItem(HELPER_RECENT_KEY, JSON.stringify([{ agent: 'codex', model: 'gpt-5', name: 'Reviewer' }, { agent: 'claude', model: null, name: null }, { agent: 'codex', model: null, name: 'Third' }]));
    const api = mkApi(view(0));
    await open(api);
    const chips = [...pop()!.querySelectorAll<HTMLButtonElement>('[data-testid="add-helper-again"] button')];
    expect(chips).toHaveLength(2);
    await act(async () => chips[0].click());
    await flush();
    expect(api.add).toHaveBeenCalledWith({ name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'C:/p', after_task: 'wait', home: 'a1' });
    expect(JSON.parse(localStorage.getItem(HELPER_RECENT_KEY)!)[0]).toMatchObject({ agent: 'codex', name: 'Reviewer' });
  });

  it('at the limit Add is off and the line says why', async () => {
    await open(mkApi(view(4, 4)));
    expect(pop()!.querySelector<HTMLButtonElement>('[data-testid="add-helper-add"]')!.disabled).toBe(true);
    expect(pop()!.textContent).toContain('You have 4 helpers on standby, the most allowed. Remove one first.');
  });

  it('a refusal from the backend is shown and the popover stays', async () => {
    const api = mkApi(view(0));
    api.add.mockRejectedValue('That project folder does not exist.');
    await open(api);
    await act(async () => pop()!.requestSubmit());
    await flush();
    expect(pop()!.querySelector('[role="alert"]')!.textContent).toContain('That project folder does not exist.');
  });

  it('What\'s new "standby.new" opens it for the agent in front, and Escape closes it', async () => {
    const api = mkApi(view(0));
    await act(async () => root.render(<AddHelperPopover api={api} front={{ id: 'a1', cwd: 'C:/p', agent: 'claude' }} />));
    expect(pop()).toBeNull();
    await act(async () => void runAction('standby.new', {}));
    await flush();
    expect(pop()).not.toBeNull();
    await act(async () => void pop()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(pop()).toBeNull();
  });
});
