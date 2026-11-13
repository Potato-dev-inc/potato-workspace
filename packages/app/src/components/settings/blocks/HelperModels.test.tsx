// @vitest-environment jsdom
// Settings > Agents > Helper agents > "Default model for helpers": one model dropdown per installed agent, saved as
// the `helper_default_models` map, found by search, and old settings without the key load fine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistryListing } from '../../../lib/agentRegistry';
import { toPublicSettings } from '../../../lib/bridge-settings';
import type { ModelOptions } from '../../../lib/modelOptions';
import { rowMatches, searchSections } from '../model';
import { SECTIONS } from '../catalog';
import { agentsRows } from '../sections/AgentsSection';
import { BASE_SETTINGS, click, mountRows, settle, type Mounted } from '../test-utils';
import { cleanHelperModels, HELPER_MODELS_HINT, hasModelChoice, withHelperModel } from './HelperModels';

const options = vi.hoisted(() => ({
  alpha: { terminal: true, defaultModel: 'gpt-5.1', models: ['gpt-5.1', 'gpt-5-mini'] },
  beta: { terminal: true, defaultModel: null, models: ['sonnet'] },
  // A shell: no model flag and no model list. Its row must not show.
  shell: { terminal: false, defaultModel: null, models: [] },
  // Not a shell by name or kind, but it still has nothing to choose: no row either.
  plain: { terminal: false, defaultModel: null, models: [] },
}) as Record<string, ModelOptions>);

vi.mock('../../../lib/modelOptions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/modelOptions')>();
  return { ...real, tauriModelOptionsApi: { get: vi.fn(async (id: string) => options[id]) } };
});

vi.mock('../../../lib/agentRegistry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRegistry')>();
  const agent = (id: string, label: string, installed = true, kind = 'cli') => ({ id, label, installed, kind }) as unknown as AgentRegistryListing['agents'][number];
  const agents = [agent('alpha', 'Alpha'), agent('beta', 'Beta'), agent('shell', 'PowerShell', true, 'shell'), agent('plain', 'Plain', true), agent('gone', 'Gone', false)];
  return { ...real, useAgentRegistry: () => ({ ...real.fallbackListing(), agents }) };
});

const row = agentsRows.filter((r) => r.id === 'helper-default-models');
let m: Mounted;
afterEach(async () => {
  await m?.unmount();
});
const chipFor = (id: string) => m.host.querySelector<HTMLButtonElement>(`[data-testid="helper-model-${id}"]`);

describe('Default model for helpers', () => {
  it('is one row in the Helpers group with a short, plain hint', () => {
    expect(row).toHaveLength(1);
    expect(row[0].group).toBe('Helpers');
    expect(HELPER_MODELS_HINT.length).toBeLessThanOrEqual(90);
    expect(row[0].hint).toBe(HELPER_MODELS_HINT);
  });

  it('is found by helper, model and default', () => {
    for (const word of ['helper', 'model', 'default']) {
      expect(rowMatches(row[0], word), word).toBe(true);
      const hits = searchSections(SECTIONS, word).flatMap((h) => h.rows.map((r) => r.id));
      expect(hits, word).toContain('helper-default-models');
    }
  });

  it('draws one dropdown per installed agent, starting at the agent default', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('alpha')?.textContent).toContain("Agent's default (Gpt-5.1)");
    expect(chipFor('beta')?.textContent).toContain("Agent's default");
    expect(chipFor('gone')).toBeNull();
  });

  it('has no PowerShell row: a shell has no model to choose', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('shell')).toBeNull();
    expect(m.host.textContent).not.toContain('PowerShell');
  });

  it('hides any agent with no model to choose, not only shells', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('plain')).toBeNull();
  });

  it('hasModelChoice: a terminal flag or a model list is enough', () => {
    expect(hasModelChoice({ terminal: false, models: [] })).toBe(false);
    expect(hasModelChoice({ terminal: true, models: [] })).toBe(true);
    expect(hasModelChoice({ terminal: false, models: ['m'] })).toBe(true);
  });

  it('saves a pick as the map entry for that agent, and Agent default removes it', async () => {
    m = await mountRows(row);
    await settle(10);
    await click(chipFor('alpha'));
    await click([...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent === 'Gpt-5-mini'));
    await settle(5);
    expect(m.env.patches).toEqual([{ helper_default_models: { alpha: 'gpt-5-mini' } }]);
    await m.rerender();
    await settle(5);
    expect(chipFor('alpha')?.textContent).toContain('Gpt-5-mini');
    await click(chipFor('alpha'));
    await click([...document.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.textContent?.startsWith("Agent's default")));
    await settle(5);
    expect(m.env.patches.at(-1)).toEqual({ helper_default_models: {} });
  });

  it('keeps other agents entries when one changes', () => {
    expect(withHelperModel({ alpha: 'a', beta: 'b' }, 'alpha', 'c')).toEqual({ alpha: 'c', beta: 'b' });
    expect(withHelperModel({ alpha: 'a', beta: 'b' }, 'alpha', '')).toEqual({ beta: 'b' });
  });

  it('old settings without the key load fine', async () => {
    expect(BASE_SETTINGS.helper_default_models).toBeUndefined();
    expect(cleanHelperModels(undefined)).toEqual({});
    expect(cleanHelperModels(['x'])).toEqual({});
    expect(cleanHelperModels({ alpha: ' m ', beta: '', gamma: 5 })).toEqual({ alpha: 'm' });
    expect(toPublicSettings(BASE_SETTINGS).helper_default_models).toEqual({});
    m = await mountRows(row);
    await settle(10);
    expect(chipFor('alpha')).not.toBeNull();
  });
});
