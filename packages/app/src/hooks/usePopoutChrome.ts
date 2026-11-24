// What every pop-out window (a pulled-out tab, an artifact window) must do on its own, because each is its own page:
// apply the text size / contrast / motion (comfort), follow the saved theme, and follow the saved language. One hook so a
// window entry cannot miss one. Returns the theme for the root's `data-theme`.
import { useEffect, useState } from 'react';
import { startLanguageSync } from '../i18n/sync';
import { useComfortRoot } from '../lib/comfort/root';
import { applyTheme, loadSettings, type AppTheme } from '../lib/settings';
import { subscribeSettingsTheme } from '../lib/settings-sync';

export function usePopoutChrome(): AppTheme {
  useComfortRoot();
  const [theme, setTheme] = useState<AppTheme>('dark');
  useEffect(() => {
    let live = true;
    loadSettings()
      .then((s) => {
        if (!live) return;
        setTheme(s.theme ?? 'dark');
        applyTheme(s.theme ?? 'dark');
      })
      .catch(() => undefined);
    const off = subscribeSettingsTheme((next) => {
      setTheme(next);
      applyTheme(next);
    });
    const offLanguage = startLanguageSync();
    return () => {
      live = false;
      off();
      offLanguage();
    };
  }, []);
  return theme;
}
