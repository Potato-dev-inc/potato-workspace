// @vitest-environment jsdom
// Settings > Orchestrator & Models: every control renders, saves the right partial patch, and search finds the rows.
import { unsearchableLabels } from '../test-utils';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { rowMatches } from '../model';
import { BASE_SETTINGS, blur, buttonByText, byLabel, hasText, mountRows, settle, type as typeInto, type Mounted } from '../test-utils';
import { modelsRows } from './ModelsSection';

let m: Mounted;

async function mount(settings: Partial<Settings> = {}) {
  m = await mountRows(modelsRows, { settings: { ...BASE_SETTINGS, ...settings } });
  await settle(5);
  return m;
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await m?.unmount();
  vi.useRealTimers();
});

const ids = modelsRows.map((r) => r.id);

describe('Orchestrator & Models: every control renders', () => {
  it('has one row per control, each in its own [data-row] wrapper', async () => {
    await mount();
    expect(ids).toEqual(['librarian-indexer', 'opencode-provider', 'opencode-model']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(m.host.querySelector(`[data-row="${id}"]`), `no row ${id}`).not.toBeNull();
  });

  it('says the OpenCode model is used with the service above, in 90 characters or fewer', async () => {
    await mount({});
    const hint = 'The model used with the service above.';
    expect(hasText(m.host, hint)).toBe(true);
    expect(hint.length).toBeLessThanOrEqual(90);
  });

  it('shows every control by its label and aria-label', async () => {
    await mount();
    for (const label of ['Project index', 'OpenCode: model service', 'OpenCode: model']) {
      expect(hasText(m.host, label), `missing label: ${label}`).toBe(true);
    }
    for (const aria of [
      'Project index',
      'OpenCode provider ID',
      'OpenCode model ID',
    ]) {
      expect(byLabel(m.host, aria), `missing control: ${aria}`).not.toBeNull();
    }
  });

  it('groups the rows under their headings in order', async () => {
    await mount();
    const heads = [...m.host.querySelectorAll('section.st-group h2')].map((h) => h.textContent);
    expect(heads).toEqual(['Project index', 'OpenCode']);
  });

  it('has no Save button, no planned controls and no destructive list', async () => {
    await mount();
    expect(buttonByText(m.host, 'Save changes')).toBeUndefined();
    expect(hasText(m.host, 'Planned')).toBe(false);
    expect(hasText(m.host, 'Not implemented')).toBe(false);
    expect(modelsRows.some((r) => r.danger)).toBe(false);
    expect(m.host.querySelector('[data-danger="true"]')).toBeNull();
  });
});

describe('Orchestrator & Models: each control saves a partial patch', () => {
  it('the removed orchestrator and API-model rows are gone', async () => {
    await mount();
    for (const gone of ['orchestrator-backend', 'default-provider', 'default-model', 'custom-models']) {
      expect(m.host.querySelector(`[data-row="${gone}"]`), gone).toBeNull();
    }
  });

  it('Project index clears to null when you leave the field, not while you type', async () => {
    await mount({ librarian_indexer_path: 'opencode' });
    const field = byLabel<HTMLInputElement>(m.host, 'Project index')!;
    expect(field.value).toBe('opencode');
    await typeInto(field, '');
    expect(m.env.patches).toHaveLength(0);
    await blur(field);
    expect(m.env.patches).toEqual([{ librarian_indexer_path: null }]);
  });

  it('Project index saves a typed path when you leave the field', async () => {
    await mount({ librarian_indexer_path: 'opencode' });
    const field = byLabel<HTMLInputElement>(m.host, 'Project index')!;
    await typeInto(field, 'scripts/project-indexer.py');
    expect(m.env.patches).toHaveLength(0);
    await blur(field);
    expect(m.env.patches).toEqual([{ librarian_indexer_path: 'scripts/project-indexer.py' }]);
  });

  it('OpenCode provider and model save on blur, and clear to null', async () => {
    await mount({ opencode_model_provider: 'anthropic', opencode_model_id: 'claude-sonnet-4' });
    const modelId = byLabel<HTMLInputElement>(m.host, 'OpenCode model ID')!;
    await typeInto(modelId, 'claude-opus-4');
    await blur(modelId);
    expect(m.env.patches).toEqual([{ opencode_model_id: 'claude-opus-4' }]);

    const provider = byLabel<HTMLInputElement>(m.host, 'OpenCode provider ID')!;
    await typeInto(provider, '');
    await blur(provider);
    expect(m.env.patches.at(-1)).toEqual({ opencode_model_provider: null });
  });
});

describe('Orchestrator & Models: search', () => {
  it('finds rows by their old words', () => {
    const row = (id: string) => modelsRows.find((r) => r.id === id)!;
    expect(rowMatches(row('librarian-indexer'), 'indexer')).toBe(true);
  });
});
