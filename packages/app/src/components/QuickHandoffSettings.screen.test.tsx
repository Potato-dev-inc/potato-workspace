// @vitest-environment jsdom
// The real Settings page: "Hand off does" (Quick handoff / Handoff to new agent) is on the Agents tab at the basic level,
// defaults to a new agent, its "Fixed notes for every handoff" box serves both modes, and search finds it by common words.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@potato-workspace/shared';
import { BASE_SETTINGS, pickOption, settle, type } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('../lib/agentRunMode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/agentRunMode')>();
  return {
    ...real,
    tauriHelperAgentsApi: {
      get: vi.fn(async () => ({ mode: 'always_show' })),
      set: vi.fn(async (mode: string) => ({ mode })),
      getKeepOpen: vi.fn(async () => ({ on: true })),
      setKeepOpen: vi.fn(async (on: boolean) => ({ on })),
      getCloseWithAgent: vi.fn(async () => ({ on: true })),
      setCloseWithAgent: vi.fn(async (on: boolean) => ({ on })),
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let current: Settings;
let api: SettingsApi;

const makeApi = (): SettingsApi => ({
  load: vi.fn(async () => ({ ...current })),
  patch: vi.fn(async (patch) => {
    current = { ...current, ...(patch as Partial<Settings>) };
    return { ...current };
  }),
  findBridgeUrl: vi.fn(async () => 'http://127.0.0.1:17321'),
  subscribe: vi.fn(() => () => undefined),
});
const row = (id: string) => host.querySelector(`[data-row="${id}"]`);
const modeSelect = () => host.querySelector<HTMLSelectElement>('select[aria-label="Hand off does"]');
const notesBox = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Fixed notes for every handoff"]');
const search = () => host.querySelector<HTMLInputElement>('input[type="search"][aria-label="Search settings"]')!;
const show = async (initialTab: 'agents' | 'look' = 'agents') => {
  api = makeApi();
  await act(async () => {
    root.render(<SettingsPanel open api={api} initialTab={initialTab} />);
  });
  await settle(10);
};

beforeEach(() => {
  current = { ...BASE_SETTINGS };
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

describe('Settings > Agents > Hand off does', () => {
  it('is on the Agents tab at the basic level, defaults to Handoff to new agent, and shows the notes box in both modes', async () => {
    await show();
    expect(row('handoff-mode')).not.toBeNull();
    // Basic: shown at first. An advanced row of the same page is not drawn until Advanced is opened.
    expect(row('preload')).toBeNull();
    expect(modeSelect()?.value).toBe('new_agent');
    expect([...modeSelect()!.options].map((o) => o.textContent)).toEqual(['Handoff to new agent', 'Quick handoff']);
    expect(notesBox()).not.toBeNull();
    expect(row('handoff-mode')?.textContent).toContain('Quick handoff saves HANDOFF.md. Handoff to new agent opens a fresh agent.');
  });

  it('choosing Quick handoff saves only that key; the notes box stays', async () => {
    await show();
    await pickOption(modeSelect()!, 'file');
    await settle(5);
    expect(api.patch).toHaveBeenCalledWith({ handoff_mode: 'file' });
    expect(modeSelect()?.value).toBe('file');
    expect(notesBox()).not.toBeNull();
    await pickOption(modeSelect()!, 'new_agent');
    await settle(5);
    expect(api.patch).toHaveBeenLastCalledWith({ handoff_mode: 'new_agent' });
  });

  it('the notes save as typed, and show again when saved already', async () => {
    current = { ...current, handoff_mode: 'file', handoff_fixed_notes: 'Be brief.' };
    await show();
    expect(modeSelect()?.value).toBe('file');
    const box = notesBox()!;
    expect(box.value).toBe('Be brief.');
    await type(box, 'Reply short. Never push.');
    await act(async () => {
      box.blur();
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await settle(5);
    expect(api.patch).toHaveBeenLastCalledWith({ handoff_fixed_notes: 'Reply short. Never push.' });
  });

  it.each(['quick handoff', 'handoff', 'hand off', 'fresh', 'ready', 'fixed notes', 'always remember'])('search "%s" finds it, from another tab', async (word) => {
    await show('look');
    await type(search(), word);
    await settle(5);
    expect(row('handoff-mode'), word).not.toBeNull();
  });
});
