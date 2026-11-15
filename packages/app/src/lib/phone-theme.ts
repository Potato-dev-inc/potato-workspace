// The phone's look: Auto (follows the phone), Light, Light dimmed or Dark. Only this phone changes; the choice is kept in localStorage.
// The page's `data-theme` (and the `dark` class and the browser bar colour) follow the resolved value; styles/phone.css and
// theme.css already read `data-theme`. Auto re-resolves when the phone's own setting flips.
import { useEffect } from 'react';

export type PhoneTheme = 'auto' | 'light' | 'dim' | 'dark';
export const PHONE_THEME_KEY = 'potato.phone.theme.v1';
export const PHONE_THEME_EVENT = 'potato:phone-theme';
const BAR_COLOR = { dark: '#1e1c1a', light: '#fdfcfa', dim: '#ece8e1' } as const;

export function parsePhoneTheme(raw: unknown): PhoneTheme {
  return raw === 'light' || raw === 'dark' || raw === 'dim' ? raw : 'auto';
}

export function readPhoneTheme(): PhoneTheme {
  try {
    return parsePhoneTheme(localStorage.getItem(PHONE_THEME_KEY));
  } catch {
    return 'auto';
  }
}

export function setPhoneTheme(theme: PhoneTheme): void {
  try {
    localStorage.setItem(PHONE_THEME_KEY, theme);
  } catch {
    /* storage blocked: the choice still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent<PhoneTheme>(PHONE_THEME_EVENT, { detail: theme }));
}

/** Auto means the phone's own light or dark setting; dark when the phone cannot say. Dim is light with the dim tone (data-tone). */
export function resolvePhoneTheme(theme: PhoneTheme): 'light' | 'dark' {
  if (theme === 'dim') return 'light';
  if (theme !== 'auto') return theme;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyPhoneTheme(theme: PhoneTheme): 'light' | 'dark' {
  const resolved = resolvePhoneTheme(theme);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  if (theme === 'dim') root.dataset.tone = 'dim';
  else delete root.dataset.tone;
  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLOR[theme === 'dim' ? 'dim' : resolved]);
  return resolved;
}

/** Apply the saved choice, and follow changes (this tab, another tab, the phone's own setting while on Auto). */
export function usePhoneTheme(): void {
  useEffect(() => {
    let current = readPhoneTheme();
    applyPhoneTheme(current);
    const onEvent = (event: Event) => {
      current = parsePhoneTheme((event as CustomEvent<unknown>).detail);
      applyPhoneTheme(current);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PHONE_THEME_KEY) return;
      current = readPhoneTheme();
      applyPhoneTheme(current);
    };
    let media: MediaQueryList | null = null;
    const onMedia = () => {
      if (current === 'auto') applyPhoneTheme(current);
    };
    try {
      media = window.matchMedia('(prefers-color-scheme: light)');
      media.addEventListener?.('change', onMedia);
    } catch {
      media = null;
    }
    window.addEventListener(PHONE_THEME_EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PHONE_THEME_EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
      media?.removeEventListener?.('change', onMedia);
    };
  }, []);
}
