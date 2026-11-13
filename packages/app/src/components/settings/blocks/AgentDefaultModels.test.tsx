// @vitest-environment jsdom
// Settings > Agents > Default model: one model dropdown per agent that has models, shells get none, an agent that cannot
// take a model in a terminal says "Only for chats", a pick is stored as the id under `agent_default_models`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistryListing } from '../../../lib/agentRegistry';
import { toPublicSettings } from '../../../lib/bridge-settings';
import type { ModelOptions } from '../../../lib/modelOptions';
import { rowMatches, searchSections } from '../model';
import { SECTIONS } from '../catalog';
import { agentsRows } from '../sections/AgentsSection';
import { BASE_SETTINGS, click, mountRows, settle, type, type Mounted } from '../test-utils';
import { AGENT_MODELS_HINT } from './AgentDefaultModels';

const options = vi.hoisted(() => ({
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] },
  claude: { terminal: true, defaultModel: 'sonnet', models: ['opus', 'sonnet', 'haiku'] },
  chatty: { terminal: false, defaultModel: null, models: ['m1', 'm2'] },
  shell: { terminal: false, defaultModel: null, models: [] },
}) as Record<string, ModelOptions>);

vi.mock('../../../lib/modelOptions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/modelOptions')>();
  return { ...real, tauriModelOptionsApi: { get: vi.fn(async (id: string) => options[id]) } };
});

vi.mock('../../../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRegistry')>();
  const agent = (id: string, label: string, installed = true, kind = 'cli') => ({ id, label, installed, kind }) as unknown as AgentRegistryListing['agents'][number];
  const agents = [agent('alpha', 'Alpha'), agent('claude', 'Claude'), agent('chatty', 'Chatty'), agent('shell', 'PowerShell', true, 'shell'), agent('gone', 'Gone', false)];
  return { ...real, useAgentRegistry: () => ({ ...real.fallbackListing(), agents }) };
});

const row = agentsRows.filter((r) => r.id === 'agent-default-models');
let m: Mounted;
afterEach(async () => {
  await m?.unmount();
});
const chipFor = (id: string) => m.host.querySelector<HTMLButtonElement>(`[data-testid="agent-model-${id}"]`);

describe('Default model per agent', () => {
  it('is one row with a short, plain hint, found by model and default', () => {
    expect(row).toHaveLength(1);
    expect(AGENT_MODELS_HINT.length).toBeLessThanOrEqual(90);
    expect(row[0].hint).toBe(AGENT_MODELS_HINT);
    for (const word of ['model', 'default']) {
      expect(rowMatches(row[0], word), word).toBe(true);
      expect(searchSections(SECTIONS, word).flatMap((h) => h.rows.map((r) => r.id))).toContain('agent-default-models');
    }
  });

  it('draws a dropdown for each installed agent with models, and none for a shell', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('alpha')?.textContent).toContain("Agent's own default (Gpt-5.1)");
    expect(chipFor('chatty')).not.toBeNull();
    expect(chipFor('shell')).toBeNull();
    expect(chipFor('gone')).toBeNull();
    expect(m.host.textContent).not.toContain('PowerShell');
  });

  it('says "Only for chats" for an agent that cannot take a model in a terminal', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(m.host.textContent).toContain('Only for chats');
    expect(m.host.textContent?.match(/Only for chats/g)).toHaveLength(1);
  });

  it('saves the model id (not the shown name), and the empty choice removes it', async () => {
    m = await mountRows(row);
    await settle(10);
    await click(chipFor('alpha'));
    await click([...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent === 'Gpt-5-mini'));
    await settle(5);
    expect(m.env.patches).toEqual([{ agent_default_models: { alpha: 'gpt-5-mini' } }]);
    await m.rerender();
    await settle(5);
    expect(chipFor('alpha')?.textContent).toContain('Gpt-5-mini');
    await click(chipFor('alpha'));
    await click([...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.startsWith("Agent's own default")));
    await settle(5);
    expect(m.env.patches.at(-1)).toEqual({ agent_default_models: {} });
  });

  it('old settings without the key load fine', async () => {
    expect(BASE_SETTINGS.agent_default_models).toBeUndefined();
    expect(toPublicSettings(BASE_SETTINGS).agent_default_models).toEqual({});
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('alpha')).not.toBeNull();
  });

  it('lists the models of an agent that has them (Claude) in a menu outside the card, so nothing clips it', async () => {
    m = await mountRows(row);
    await settle(10);
    await click(chipFor('claude'));
    const menu = document.querySelector<HTMLElement>('.mp-menu');
    expect(menu).not.toBeNull();
    expect(m.host.contains(menu)).toBe(false);
    expect(menu?.style.position).toBe('fixed');
    const names = [...menu!.querySelectorAll('[role=option]')].map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Opus', 'Sonnet', 'Haiku']));
    expect(menu?.querySelector('input')).not.toBeNull();
  });

  it('every agent takes a typed model id, and it is saved as typed', async () => {
    m = await mountRows(row);
    await settle(10);
    await click(chipFor('claude'));
    const box = document.querySelector<HTMLInputElement>('.mp-menu input')!;
    await type(box, 'claude-opus-4-1');
    await click([...document.querySelectorAll<HTMLElement>('.mp-menu [role=option]')].find((o) => o.textContent?.includes('claude-opus-4-1')));
    await settle(5);
    expect(m.env.patches.at(-1)).toEqual({ agent_default_models: { claude: 'claude-opus-4-1' } });
  });
});
