// @vitest-environment jsdom
// The saved Chat | Terminal choice of the "+" menu: Chat when nothing is saved, the saved word otherwise, saved through the
// settings patch as `new_agent_start`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadSettings = vi.fn();
const patchSettings = vi.fn(async (_patch: unknown) => ({}));
vi.mock('./settings', () => ({ loadSettings: (...a: unknown[]) => loadSettings(...a), patchSettings: (...a: unknown[]) => patchSettings(a[0]) }));

import { parseStartMode, settingsStartModeApi, useStartMode, type StartMode } from './newAgentStart';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('new agent start mode', () => {
  it('is Chat unless the saved word is terminal', () => {
    expect(parseStartMode(undefined)).toBe('chat');
    expect(parseStartMode('chat')).toBe('chat');
    expect(parseStartMode('nonsense')).toBe('chat');
    expect(parseStartMode('terminal')).toBe('terminal');
  });

  it('reads the setting and saves the choice as a patch of that one key', async () => {
    loadSettings.mockResolvedValueOnce({});
    expect(await settingsStartModeApi.get()).toBe('chat');
    loadSettings.mockResolvedValueOnce({ new_agent_start: 'terminal' });
    expect(await settingsStartModeApi.get()).toBe('terminal');
    await settingsStartModeApi.set('terminal');
    expect(patchSettings).toHaveBeenCalledWith({ new_agent_start: 'terminal' });
  });

  describe('the hook', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
      host = document.createElement('div');
      root = createRoot(host);
    });
    afterEach(() => act(() => root.unmount()));
    let seen: { mode: StartMode; choose: (m: StartMode) => void };
    const Probe = ({ active, api }: { active: boolean; api: Parameters<typeof useStartMode>[1] }) => {
      const [mode, choose] = useStartMode(active, api);
      seen = { mode, choose };
      return null;
    };

    it('starts on Chat, reads the saved mode when it becomes active, and shows a pick at once while saving it', async () => {
      const api = { get: vi.fn(async () => 'terminal' as StartMode), set: vi.fn(async () => undefined) };
      await act(async () => root.render(<Probe active={false} api={api} />));
      expect(seen.mode).toBe('chat');
      expect(api.get).not.toHaveBeenCalled();
      await act(async () => root.render(<Probe active api={api} />));
      expect(seen.mode).toBe('terminal');
      await act(async () => seen.choose('chat'));
      expect(seen.mode).toBe('chat');
      expect(api.set).toHaveBeenCalledWith('chat');
    });

    it('stays on Chat when the settings cannot be read', async () => {
      const api = { get: vi.fn(async () => Promise.reject(new Error('no settings'))), set: vi.fn(async () => Promise.reject(new Error('no settings'))) };
      await act(async () => root.render(<Probe active api={api} />));
      expect(seen.mode).toBe('chat');
      await act(async () => seen.choose('terminal'));
      expect(seen.mode).toBe('terminal');
    });
  });
});
