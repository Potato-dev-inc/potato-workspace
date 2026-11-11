// The person's own shortcuts (the `keybindings` setting) for this window. `useKeybindingsSync` loads them and keeps them
// fresh when Settings (any window) saves; every handler and hint then reads lib/shortcuts.ts. `useKeybindingsVersion`
// makes a component draw again when they change, so a tooltip never shows an old key.
import { useEffect, useSyncExternalStore } from 'react';
import { keybindingsVersion, setKeybindings, subscribeKeybindings } from '../lib/shortcuts';
import { loadSettings } from '../lib/settings';
import { subscribeSettingsRefresh } from '../lib/settings-sync';

/** Call once, high in the window (CockpitApp). */
export function useKeybindingsSync(): void {
  useEffect(() => {
    let disposed = false;
    const load = () => {
      loadSettings()
        .then((settings) => {
          if (!disposed) setKeybindings(settings.keybindings);
        })
        .catch(() => undefined);
    };
    load();
    const off = subscribeSettingsRefresh((info) => {
      if (info.reason === 'changed' || info.reason === 'show') load();
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);
}

/** A number that changes whenever the shortcuts do. Read it in a component that shows a shortcut. */
export function useKeybindingsVersion(): number {
  return useSyncExternalStore(subscribeKeybindings, keybindingsVersion, keybindingsVersion);
}
