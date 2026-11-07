// What the "+" menu starts: a chat or a terminal. One switch at the top of the menu, saved as the `new_agent_start`
// setting. Absent means Chat. Nothing here names an agent.
import { useCallback, useEffect, useState } from 'react';
import { loadSettings, patchSettings } from './settings';

export type StartMode = 'chat' | 'terminal';

export const DEFAULT_START_MODE: StartMode = 'chat';

export interface StartModeApi {
  get: () => Promise<StartMode>;
  set: (mode: StartMode) => Promise<void>;
}

export const parseStartMode = (raw: unknown): StartMode => (raw === 'terminal' ? 'terminal' : DEFAULT_START_MODE);

export const settingsStartModeApi: StartModeApi = {
  get: async () => parseStartMode((await loadSettings()).new_agent_start),
  set: async (mode) => {
    await patchSettings({ new_agent_start: mode });
  },
};

/** The saved mode (Chat until it is read), read each time `active` turns on, and a setter that shows at once and saves. */
export function useStartMode(active: boolean, api: StartModeApi = settingsStartModeApi): [StartMode, (mode: StartMode) => void] {
  const [mode, setMode] = useState<StartMode>(DEFAULT_START_MODE);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    api
      .get()
      .then((m) => live && setMode(m))
      .catch(() => undefined); // no settings (a browser): Chat
    return () => {
      live = false;
    };
  }, [active, api]);
  const choose = useCallback(
    (next: StartMode) => {
      setMode(next);
      api.set(next).catch(() => undefined);
    },
    [api],
  );
  return [mode, choose];
}
