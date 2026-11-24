// "Show questions that block an agent" (Settings > General > While agents work): ON unless the settings file says false.
// Read like lib/simple-mode.ts; the last known value is cached only so the first frame is right.
import { useEffect, useState } from 'react';
import { listen } from './events';
import { loadSettings } from './settings';

const CACHE_KEY = 'pm-jump-out-cards';

function cached(): boolean {
  try {
    return window.localStorage.getItem(CACHE_KEY) !== '0';
  } catch {
    return true;
  }
}

function remember(on: boolean): void {
  try {
    window.localStorage.setItem(CACHE_KEY, on ? '1' : '0');
  } catch {
    /* a private window: the settings file still decides */
  }
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The value of the switch, kept current when Settings (any window) changes it. */
export function useJumpOutEnabled(): boolean {
  const [on, setOn] = useState<boolean>(cached);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const apply = (value: boolean) => {
      if (disposed) return;
      remember(value);
      setOn(value);
    };
    loadSettings()
      .then((s) => apply(s.jump_out_cards_enabled !== false))
      .catch(() => undefined);
    if (inTauri()) {
      void listen<{ jump_out_cards_enabled?: unknown } | null>('settings://changed', (event) => {
        const value = event.payload?.jump_out_cards_enabled;
        if (typeof value === 'boolean') apply(value);
      })
        .then((un) => (disposed ? un() : (off = un)))
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return on;
}
