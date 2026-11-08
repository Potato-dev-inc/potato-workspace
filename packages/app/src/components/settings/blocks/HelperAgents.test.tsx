// @vitest-environment jsdom
// Settings > Agents > Helpers: "Helper agents" (always show by default) and "Keep helpers open when they finish"
// (on by default). Each saves through its own command, says what it does in plain words, and is found by search.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowMatches } from '../model';
import { agentsRows } from '../sections/AgentsSection';
import { click, hasText, mountRows, pickOption, settle, type Mounted } from '../test-utils';

const saved = vi.hoisted(() => ({ mode: 'always_show', keepOpen: true }));

vi.mock('../../../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRunMode')>();
  return {
    ...real,
    tauriHelperAgentsApi: {
      get: vi.fn(async () => ({ mode: saved.mode })),
      set: vi.fn(async (mode: string) => {
        saved.mode = mode;
        return { mode };
      }),
      getKeepOpen: vi.fn(async () => ({ on: saved.keepOpen })),
      setKeepOpen: vi.fn(async (on: boolean) => {
        saved.keepOpen = on;
        return { on };
      }),
    },
  };
});

const choiceRow = agentsRows.filter((r) => r.id === 'helper-agents');
const keepRow = agentsRows.filter((r) => r.id === 'keep-helpers-open');
let m: Mounted;
const choice = () => m.host.querySelector<HTMLSelectElement>('select[aria-label="Helper agents"]');
const toggle = () => m.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Keep helpers open when they finish"]');

beforeEach(() => {
  saved.mode = 'always_show';
  saved.keepOpen = true;
});

afterEach(async () => {
  await m?.unmount();
});

describe('Helper agents', () => {
  it('is a row in the Agents settings', () => {
    expect(choiceRow).toHaveLength(1);
    expect(choiceRow[0].group).toBe('Helpers');
  });

  it('defaults to always showing helpers and says what the choices do', async () => {
    m = await mountRows(choiceRow);
    await settle(10);
    expect(choice()?.value).toBe('always_show');
    expect([...choice()!.options].map((o) => o.textContent)).toEqual([
      'Always show them',
      'Let the agent choose',
      'Always run in the background',
    ]);
    expect(hasText(m.host, 'open in their own pane even if the agent asks for background mode')).toBe(true);
    expect(hasText(m.host, 'Claude Code')).toBe(false);
  });

  it('saves through its own command, not the phone-patchable settings', async () => {
    const { tauriHelperAgentsApi } = await import('../../../lib/agentRunMode');
    m = await mountRows(choiceRow);
    await settle(10);
    await pickOption(choice()!, 'always_background');
    await settle(5);
    expect(tauriHelperAgentsApi.set).toHaveBeenCalledWith('always_background');
    expect(saved.mode).toBe('always_background');
    expect(choice()?.value).toBe('always_background');
    expect(m.env.patches).toEqual([]);
  });

  it('reads a saved choice back', async () => {
    saved.mode = 'agent_chooses';
    m = await mountRows(choiceRow);
    await settle(10);
    expect(choice()?.value).toBe('agent_chooses');
  });

  it('is found by the words a person would type', () => {
    for (const words of ['hidden helper', 'headless', 'subagent', 'no window', 'always show']) {
      expect(rowMatches(choiceRow[0], words), words).toBe(true);
    }
  });
});

describe('Keep helpers open when they finish', () => {
  it('is a row in the Agents settings and on by default', async () => {
    expect(keepRow).toHaveLength(1);
    m = await mountRows(keepRow);
    await settle(10);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(hasText(m.host, 'stays open')).toBe(true);
  });

  it('saves through its own command in both directions', async () => {
    const { tauriHelperAgentsApi } = await import('../../../lib/agentRunMode');
    m = await mountRows(keepRow);
    await settle(10);
    await click(toggle());
    await settle(5);
    expect(tauriHelperAgentsApi.setKeepOpen).toHaveBeenCalledWith(false);
    expect(saved.keepOpen).toBe(false);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    await click(toggle());
    await settle(5);
    expect(tauriHelperAgentsApi.setKeepOpen).toHaveBeenLastCalledWith(true);
    expect(m.env.patches).toEqual([]);
  });

  it('reads a saved off as off', async () => {
    saved.keepOpen = false;
    m = await mountRows(keepRow);
    await settle(10);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
  });

  it('is found by the words a person would type', () => {
    for (const words of ['keep open', 'close pane', 'finished']) {
      expect(rowMatches(keepRow[0], words), words).toBe(true);
    }
  });
});
