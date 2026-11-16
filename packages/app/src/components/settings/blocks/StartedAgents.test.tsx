// @vitest-environment jsdom
// Settings > Agents > Helpers: "Agents that agents start" (One type by default) and, only in Two types, "When an agent
// starts another agent". Tested through the real Agents rows, like the other helper rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowMatches } from '../model';
import { agentsRows } from '../sections/AgentsSection';
import { hasText, mountRows, pickOption, settle, type Mounted } from '../test-utils';

const saved = vi.hoisted(() => ({ types: 'one', kind: 'agent_chooses' }));

vi.mock('../../../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRunMode')>();
  return {
    ...real,
    tauriStartedAgentsApi: {
      get: vi.fn(async () => ({ types: saved.types, kind: saved.kind })),
      set: vi.fn(async (change: { types?: string; kind?: string }) => {
        if (change.types) saved.types = change.types;
        if (change.kind) saved.kind = change.kind;
        return { types: saved.types, kind: saved.kind };
      }),
    },
  };
});

const rows = agentsRows.filter((r) => r.id === 'started-agents');
let m: Mounted;
const types = () => m.host.querySelector<HTMLSelectElement>('select[aria-label="Agents that agents start"]');
const kind = () => m.host.querySelector<HTMLSelectElement>('select[aria-label="When an agent starts another agent"]');

beforeEach(() => {
  saved.types = 'one';
  saved.kind = 'agent_chooses';
});

afterEach(async () => {
  await m?.unmount();
});

describe('Agents that agents start', () => {
  it('is the first row of the Helpers group in the Agents settings', () => {
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe('How helpers run');
    expect(agentsRows.find((r) => r.group === 'How helpers run' && r.id !== 'helper-tools')?.id).toBe('started-agents');
  });

  it('defaults to One type and shows no second row', async () => {
    m = await mountRows(rows);
    await settle(10);
    expect(types()?.value).toBe('one');
    expect([...types()!.options].map((o) => o.textContent)).toEqual(['One type', 'Two types']);
    expect(hasText(m.host, 'One type: as today')).toBe(true);
    expect(kind()).toBeNull();
  });

  it('saves Two types through its own command and then shows the kind row with Let it choose', async () => {
    const { tauriStartedAgentsApi } = await import('../../../lib/agentRunMode');
    m = await mountRows(rows);
    await settle(10);
    await pickOption(types()!, 'two');
    await settle(5);
    expect(tauriStartedAgentsApi.set).toHaveBeenCalledWith({ types: 'two' });
    expect(saved.types).toBe('two');
    expect(m.env.patches).toEqual([]);
    expect(kind()?.value).toBe('agent_chooses');
    expect([...kind()!.options].map((o) => o.textContent)).toEqual(['Let it choose', 'Minion', 'Spin-off']);
    await pickOption(kind()!, 'spin_off');
    await settle(5);
    expect(tauriStartedAgentsApi.set).toHaveBeenLastCalledWith({ kind: 'spin_off' });
    expect(saved.kind).toBe('spin_off');
    expect(kind()?.value).toBe('spin_off');
  });

  it('reads a saved choice back, and going back to One type keeps the kind', async () => {
    saved.types = 'two';
    saved.kind = 'minion';
    m = await mountRows(rows);
    await settle(10);
    expect(types()?.value).toBe('two');
    expect(kind()?.value).toBe('minion');
    await pickOption(types()!, 'one');
    await settle(5);
    expect(kind()).toBeNull();
    expect(saved.kind).toBe('minion');
  });

  it('is found by the words a person would type', () => {
    for (const words of ['minion', 'spin-off', 'two types', 'subagent']) {
      expect(rowMatches(rows[0], words), words).toBe(true);
    }
  });
});
