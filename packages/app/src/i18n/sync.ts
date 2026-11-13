// Keeps the language in step with the saved setting `ui_language`: read once at start, then follow every window that saves it.
import { isLanguagePref, setLanguagePref } from './index';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Call once per window, before the first render. Returns the unsubscribe function. */
export function startLanguageSync(): () => void {
  if (!inTauri()) return () => undefined;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void import('../lib/settings')
    .then(({ loadSettings }) => loadSettings())
    .then((settings) => {
      if (!disposed) setLanguagePref(isLanguagePref(settings.ui_language) ? settings.ui_language : 'auto');
    })
    .catch(() => undefined);
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<{ ui_language?: unknown } | null>('settings://changed', (event) => {
        const next = event.payload?.ui_language;
        if (isLanguagePref(next)) setLanguagePref(next);
        else if (next === null) setLanguagePref('auto');
      }),
    )
    .then((un) => (disposed ? un() : (unlisten = un)))
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}
