// @vitest-environment jsdom
// Settings > Agents > Helpers: "Allow hidden helpers" is off until the person turns it on, saves through its own
// command, says what it does in plain words, and is found by search.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowMatches } from '../model';
import { agentsRows } from '../sections/AgentsSection';
import { click, hasText, mountRows, settle, type Mounted } from '../test-utils';

const saved = vi.hoisted(() => ({ allowed: false }));

vi.mock('../../../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/agentRunMode')>();
  return {
    ...real,
    tauriHiddenHelpersApi: {
      get: vi.fn(async () => ({ allowed: saved.allowed })),
      set: vi.fn(async (allowed: boolean) => {
        saved.allowed = allowed;
        return { allowed };
      }),
    },
  };
});

const row = agentsRows.filter((r) => r.id === 'hidden-helpers');
let m: Mounted;
const toggle = () => m.host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Allow hidden helpers"]');

beforeEach(() => {
  saved.allowed = false;
});

afterEach(async () => {
  await m?.unmount();
});

describe('Allow hidden helpers', () => {
  it('is a row in the Agents settings', () => {
    expect(row).toHaveLength(1);
    expect(row[0].group).toBe('Helpers');
  });

  it('is off by default and says what it does', async () => {
    m = await mountRows(row);
    await settle(10);
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(hasText(m.host, 'always shows up as a pane')).toBe(true);
    expect(hasText(m.host, 'Claude Code')).toBe(false);
  });

  it('saves through its own command and shows the saved state', async () => {
    const { tauriHiddenHelpersApi } = await import('../../../lib/agentRunMode');
    m = await mountRows(row);
    await settle(10);
    await click(toggle());
    await settle(5);
    expect(tauriHiddenHelpersApi.set).toHaveBeenCalledWith(true);
    expect(saved.allowed).toBe(true);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(m.env.patches).toEqual([]); // not in the phone-patchable settings mirror
    await click(toggle());
    await settle(5);
    expect(tauriHiddenHelpersApi.set).toHaveBeenLastCalledWith(false);
  });

  it('reads a saved on as on', async () => {
    saved.allowed = true;
    m = await mountRows(row);
    await settle(10);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });

  it('is found by the words a person would type', () => {
    for (const words of ['hidden helper', 'headless', 'subagent', 'no window']) {
      expect(rowMatches(row[0], words), words).toBe(true);
    }
  });
});
