// @vitest-environment jsdom
// The Settings page with the REAL catalog: the Agents tab shows the three helper rows together, the new one
// "Close started agents when their agent closes" among them, and its switch saves through its own command.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, click, pickOption, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

const saved = vi.hoisted(() => ({ mode: 'always_show', keepOpen: true, closeWithAgent: true, mostAtOnce: 8 }));

vi.mock('../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentRunMode')>();
  return {
    ...real,
    tauriHelperAgentsApi: {
      get: vi.fn(async () => ({ mode: saved.mode })),
      set: vi.fn(async (mode: string) => ({ mode })),
      getKeepOpen: vi.fn(async () => ({ on: saved.keepOpen })),
      setKeepOpen: vi.fn(async (on: boolean) => ({ on })),
      getMostAtOnce: vi.fn(async () => ({ value: saved.mostAtOnce })),
      setMostAtOnce: vi.fn(async (value: number) => {
        saved.mostAtOnce = value;
        return { value };
      }),
      getCloseWithAgent: vi.fn(async () => ({ on: saved.closeWithAgent })),
      setCloseWithAgent: vi.fn(async (on: boolean) => {
        saved.closeWithAgent = on;
        return { on };
      }),
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let current: Settings;

function makeApi(): SettingsApi {
  return {
    load: vi.fn(async () => ({ ...current })),
    patch: vi.fn(async () => ({ ...current })),
    findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
    subscribe: vi.fn(() => () => undefined),
  };
}

const row = (id: string) => host.querySelector(`[data-row="${id}"]`);
const closeSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Close started agents when their agent closes"]');

beforeEach(() => {
  current = { ...BASE_SETTINGS };
  saved.closeWithAgent = true;
  saved.mostAtOnce = 8;
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Settings > Agents > Helpers on the real page', () => {
  it('shows "Close started agents when their agent closes" next to the other helper settings, on by default', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    expect(row('helper-agents')).not.toBeNull();
    expect(row('keep-helpers-open')).not.toBeNull();
    const closeRow = row('close-helpers-with-agent');
    expect(closeRow).not.toBeNull();
    expect(closeRow?.textContent).toContain('Close started agents when their agent closes');
    expect(closeSwitch()?.getAttribute('aria-checked')).toBe('true');
    // Same group, right after "Keep started agents open when they finish".
    expect(row('keep-helpers-open')?.nextElementSibling).toBe(closeRow);
  });

  it('turning it off saves through its own command', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    await click(closeSwitch());
    await settle(5);
    expect(saved.closeWithAgent).toBe(false);
    expect(closeSwitch()?.getAttribute('aria-checked')).toBe('false');
  });
});

describe('Settings > Agents > Helpers: Most started agents at once on the real page', () => {
  it('shows the row after the other helper settings, set to 8, and a change saves through its own command', async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
    // A rarely changed setting: it sits under Advanced until that is opened.
    expect(row('most-helpers-at-once')).toBeNull();
    await click(host.querySelector<HTMLButtonElement>('.st-adv-toggle'));
    await settle(10);
    const most = row('most-helpers-at-once');
    expect(most).not.toBeNull();
    expect(most?.textContent).toContain('Most started agents at once');
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Most started agents at once"]');
    expect(select?.value).toBe('8');
    await pickOption(select!, '4');
    await settle(5);
    expect(saved.mostAtOnce).toBe(4);
  });
});

// Slice 11: "Let agents ask each other for help" is one switch. On = every installed agent is set up (the same apply the
// review sheet runs), with a one-line notice and Undo. A later change shows "Fix it".
const pack = vi.hoisted(() => ({
  state: { recorded: 0, drift: false },
  apply: vi.fn(),
  undo: vi.fn(),
}));
vi.mock('../lib/agent-pack', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agent-pack')>();
  const { AGENT_PACK_PREVIEW } = await import('../dev/fixtures');
  const report = (written: boolean) => ({
    ...AGENT_PACK_PREVIEW,
    dry_run: false,
    recorded: pack.state.recorded,
    agents: AGENT_PACK_PREVIEW.agents.map((a) => ({
      ...a,
      skills: a.skills && { ...a.skills, status: written || (pack.state.recorded > 0 && !pack.state.drift) ? ('unchanged' as const) : a.skills.status, written: written && a.skills.status === 'ready' },
      mcp: a.mcp && { ...a.mcp, status: written || (pack.state.recorded > 0 && !pack.state.drift) ? ('unchanged' as const) : a.mcp.status, written: written && a.mcp.status === 'ready' },
    })),
  });
  return {
    ...real,
    agentPackApi: {
      ...real.agentPackApi,
      preview: async () => report(false),
      apply: async () => {
        pack.apply();
        pack.state = { recorded: 9, drift: false };
        return report(true);
      },
      undo: async () => {
        pack.undo();
        pack.state = { recorded: 0, drift: false };
        return { restored: [], removed: ['a', 'b'], skipped: [], recorded: 0 };
      },
    },
  };
});

describe('Settings > Helpers > Agents can ask each other for help (one switch)', () => {
  const packSwitch = () => host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Let agents ask each other for help"]');
  const buttonText = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  const open = async () => {
    await act(async () => {
      root.render(<SettingsPanel open api={makeApi()} initialTab="helpers" />);
    });
    await settle(10);
  };

  beforeEach(() => {
    pack.state = { recorded: 0, drift: false };
    pack.apply.mockClear();
    pack.undo.mockClear();
  });

  it('shows one switch, off, and no Undo before anything is set up', async () => {
    await open();
    expect(packSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(buttonText('Undo')).toBeUndefined();
    expect(buttonText('Fix it')).toBeUndefined();
  });

  it('turning it on sets up every installed agent at once, says so in one line, and keeps Undo', async () => {
    await open();
    await click(packSwitch());
    await settle(8);
    expect(pack.apply).toHaveBeenCalledTimes(1);
    expect(packSwitch()?.getAttribute('aria-checked')).toBe('true');
    const group = host.querySelector('section[aria-label="Let agents ask each other for help"]')!;
    // Every installed agent that had something to add is named in the notice.
    expect(group.textContent).toContain('Set up for Claude, Codex, OpenCode.');
    expect(group.textContent).toContain('Undo puts it back');
    expect(buttonText('Undo')).toBeTruthy();
    expect(buttonText('Fix it')).toBeUndefined();
  });

  it('turning it off, or pressing Undo, puts everything back', async () => {
    pack.state = { recorded: 9, drift: false };
    await open();
    expect(packSwitch()?.getAttribute('aria-checked')).toBe('true');
    await click(packSwitch());
    await settle(8);
    expect(pack.undo).toHaveBeenCalledTimes(1);
    expect(packSwitch()?.getAttribute('aria-checked')).toBe('false');
    expect(buttonText('Undo')).toBeUndefined();
  });

  it('when an agent drifted after the set-up, "Fix it" appears and runs the set-up again', async () => {
    pack.state = { recorded: 9, drift: true };
    await open();
    expect(host.querySelector('[data-testid="pack-drift"]')?.textContent).toContain('missing part of the set-up');
    await click(buttonText('Fix it'));
    await settle(8);
    expect(pack.apply).toHaveBeenCalledTimes(1);
    expect(buttonText('Fix it')).toBeUndefined();
    expect(host.querySelector('[data-testid="pack-drift"]')).toBeNull();
  });
});
