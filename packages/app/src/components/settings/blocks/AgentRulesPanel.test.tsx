// @vitest-environment jsdom
// Settings > Agents > Rules for agents, through the real Agents rows: it is found by its words, Force yes asks before it
// turns on, a fence is added and removed, and the starting settings of new agents are saved for every project or one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistryListing } from '../../../lib/agentRegistry';
import type { AgentRulesApi, Pin, RulesOverview } from '../../../lib/agentRules';
import { writeProjects } from '../../../lib/sidebarProjects';
import { SECTIONS } from '../catalog';
import { searchSections } from '../model';
import { agentsRows } from '../sections/AgentsSection';
import { click, mountRows, settle, type, type Mounted } from '../test-utils';

const state = vi.hoisted(() => ({ overview: { forceYesAgents: [], pinGlobal: {}, projects: [] } as unknown as RulesOverview }));
const calls = vi.hoisted(() => ({ setForceYesAgent: vi.fn(), fenceAdd: vi.fn(), fenceRemove: vi.fn(), pinSet: vi.fn() }));

vi.mock('../../../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRegistry')>();
  const agent = (id: string, label: string, installed = true, kind = 'cli') => ({ id, label, installed, kind }) as unknown as AgentRegistryListing['agents'][number];
  const agents = [agent('agy', 'Agy'), agent('claude', 'Claude'), agent('shell', 'PowerShell', true, 'shell'), agent('gone', 'Gone', false)];
  return { ...real, useAgentRegistry: () => ({ ...real.fallbackListing(), agents }) };
});

vi.mock('../../../lib/agentRules', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRules')>();
  const api: AgentRulesApi = {
    overview: async () => state.overview,
    effective: async () => real.NO_PINS,
    setForceYesAgent: async (agent, on) => {
      calls.setForceYesAgent(agent, on);
      state.overview = { ...state.overview, forceYesAgents: on ? [agent] : [] };
      return on;
    },
    fenceAdd: async (project, path) => {
      calls.fenceAdd(project, path);
      const key = real.ruleKey(project);
      state.overview = { ...state.overview, projects: [{ project: key, fences: [path], pin: {} }] };
      return [path];
    },
    fenceRemove: async (project, fence) => {
      calls.fenceRemove(project, fence);
      state.overview = { ...state.overview, projects: [] };
      return [];
    },
    pinSet: async (project, pin: Pin) => {
      calls.pinSet(project, pin);
      return pin;
    },
    paneSetForceYes: async (_id, on) => on,
    paneForceYes: async () => false,
  };
  return { ...real, tauriAgentRulesApi: api };
});

const rows = agentsRows.filter((r) => r.id === 'agent-rules');
let m: Mounted;
beforeEach(() => {
  state.overview = { forceYesAgents: [], pinGlobal: {}, projects: [] };
  Object.values(calls).forEach((fn) => fn.mockClear());
  writeProjects([{ path: 'D:\\work\\shop' }]);
});
afterEach(async () => {
  await m?.unmount();
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});
const q = <T extends Element = HTMLElement>(sel: string) => m.host.querySelector<T>(sel);

describe('Rules for agents in Settings', () => {
  it('is a row of the Agents page, found by force yes, fence and pins', () => {
    expect(rows).toHaveLength(1);
    for (const word of ['force yes', 'fence', 'pinned', 'starting settings']) {
      const hit = searchSections(SECTIONS, word).find((h) => h.rows.some((r) => r.id === 'agent-rules'));
      expect(hit, word).toBeTruthy();
    }
    expect(SECTIONS.find((s) => s.id === 'agents')?.rows.map((r) => r.id)).toContain('agent-rules');
  });

  it('starts empty, without failing, when the app answers nothing', async () => {
    state.overview = null as unknown as RulesOverview;
    m = await mountRows(rows);
    await settle(10);
    expect(q('[data-testid="agent-rules-panel"]')).not.toBeNull();
    expect(m.host.textContent).toContain('No fences in this project.');
  });

  it('lists the installed agents (no shell, no missing one) with Force yes off', async () => {
    m = await mountRows(rows);
    await settle(10);
    expect(q('[data-testid="rules-force-yes-agy"]')).not.toBeNull();
    expect(q('[data-testid="rules-force-yes-claude"]')).not.toBeNull();
    expect(q('[data-testid="rules-force-yes-shell"]')).toBeNull();
    expect(q('[data-testid="rules-force-yes-gone"]')).toBeNull();
    expect(q('[data-testid="rules-force-yes-agy"] [role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the warning first and turns Force yes on only after "Turn on"', async () => {
    m = await mountRows(rows);
    await settle(10);
    await click(q('[data-testid="rules-force-yes-agy"] [role="switch"]'));
    await settle(3);
    expect(q('[role="alertdialog"]')?.textContent).toContain('Risky or destructive asks');
    expect(calls.setForceYesAgent).not.toHaveBeenCalled();
    await click(q('[data-testid="rules-force-yes-confirm-agy"]'));
    await settle(10);
    expect(calls.setForceYesAgent).toHaveBeenCalledWith('agy', true);
    expect(q('[data-testid="rules-force-yes-agy"] [role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    // Off again: no question.
    await click(q('[data-testid="rules-force-yes-agy"] [role="switch"]'));
    await settle(10);
    expect(calls.setForceYesAgent).toHaveBeenLastCalledWith('agy', false);
  });

  it('adds a fence to the chosen project and takes it off again', async () => {
    m = await mountRows(rows);
    await settle(10);
    expect(m.host.textContent).toContain('No fences in this project.');
    await type(q<HTMLInputElement>('input[aria-label="Fence a folder or file"]')!, 'secrets');
    await click(m.host.querySelector<HTMLButtonElement>('button[type="submit"]'));
    await settle(10);
    expect(calls.fenceAdd).toHaveBeenCalledWith('D:\\work\\shop', 'secrets');
    expect(q('[data-testid="rules-fences"]')?.textContent).toContain('secrets');
    await click(q('button[aria-label="Remove fence secrets"]'));
    await settle(10);
    expect(calls.fenceRemove).toHaveBeenCalledWith('D:\\work\\shop', 'secrets');
    expect(m.host.textContent).toContain('No fences in this project.');
  });

  it('saves the starting settings for every project, then for one project', async () => {
    m = await mountRows(rows);
    await settle(10);
    await type(q<HTMLInputElement>('[data-testid="rules-pins"] input[type="text"]')!, 'big-model');
    await type(q<HTMLTextAreaElement>('[data-testid="rules-pins"] textarea')!, 'Run the tests first.');
    await click(q('[data-testid="rules-pin-save"]'));
    await settle(10);
    expect(calls.pinSet).toHaveBeenCalledWith(null, expect.objectContaining({ model: 'big-model', notes: 'Run the tests first.' }));
    expect(m.host.textContent).toContain('Saved');
    const scope = q<HTMLSelectElement>('[data-testid="rules-pin-scope"]')!;
    expect([...scope.options].map((o) => o.textContent)).toEqual(['Every project', 'This project: shop']);
    scope.value = 'D:\\work\\shop';
    scope.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(5);
    await click(q('[data-testid="rules-pin-save"]'));
    await settle(10);
    expect(calls.pinSet).toHaveBeenLastCalledWith('D:\\work\\shop', expect.any(Object));
  });
});
