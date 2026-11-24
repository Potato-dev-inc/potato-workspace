// Is the mark-up bar's Labs switch on? (Settings, or a development build.) Off until the app answers.
import { useEffect, useState } from 'react';
import { listen } from '../events';
import { loadSettings } from '../settings';

export const MARKUP_LABS_KEY = 'markup_bar_enabled' as const;

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useMarkupEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    const read = () =>
      loadSettings().then(
        (s) => !disposed && setOn((s as { markup_bar_enabled?: boolean }).markup_bar_enabled === true),
        () => undefined,
      );
    void read();
    listen('settings://changed', () => void read())
      .then((un) => (disposed ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return on;
}
