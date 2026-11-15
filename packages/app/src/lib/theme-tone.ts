// The stored `theme` setting is 'dark' | 'light' | 'dim' | 'auto'. The page only knows two attributes:
//   data-theme = dark | light   and   data-tone = dim (only with light).
// "Light, dimmed" is data-theme='light' + data-tone='dim', so every [data-theme='light'] rule (logos, viewers) keeps working.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'dark' | 'light' | 'dim' | 'auto';
export interface ResolvedTheme {
  theme: 'dark' | 'light';
  tone: 'dim' | null;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'dark' || value === 'light' || value === 'dim' || value === 'auto';
}

/** Pure: the attributes a choice gives. Auto follows the system (dark when it cannot say). */
export function resolveTheme(choice: ThemeChoice | undefined | null, systemLight: boolean): ResolvedTheme {
  if (choice === 'light') return { theme: 'light', tone: null };
  if (choice === 'dim') return { theme: 'light', tone: 'dim' };
  if (choice === 'auto') return systemLight ? { theme: 'light', tone: null } : { theme: 'dark', tone: null };
  return { theme: 'dark', tone: null };
}

/** The system's own light/dark setting; false (dark) when it cannot be read. */
export function systemPrefersLight(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

/** Props for a root element: `<div {...themeAttrs(theme)}>`. */
export function themeAttrs(choice: ThemeChoice | undefined | null, systemLight: boolean = systemPrefersLight()): { 'data-theme': 'dark' | 'light'; 'data-tone'?: 'dim' } {
  const r = resolveTheme(choice, systemLight);
  return r.tone ? { 'data-theme': r.theme, 'data-tone': r.tone } : { 'data-theme': r.theme };
}

/** True when the choice shows a dark window. */
export function isDarkTheme(choice: ThemeChoice | undefined | null, systemLight: boolean = systemPrefersLight()): boolean {
  return resolveTheme(choice, systemLight).theme === 'dark';
}

/** The sun/moon toggle: dark goes to light, anything light (dimmed included) goes to dark. Auto resolves first. */
export function toggledTheme(choice: ThemeChoice | undefined | null, systemLight: boolean = systemPrefersLight()): 'dark' | 'light' {
  return isDarkTheme(choice, systemLight) ? 'light' : 'dark';
}

/** Watch the system's light/dark setting. Returns the unsubscribe function; safe where matchMedia is missing. */
export function watchSystemTheme(onChange: () => void): () => void {
  try {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  } catch {
    return () => undefined;
  }
}

/** Root attributes for a window; on Auto they follow the system while the window is open. */
export function useThemeAttrs(choice: ThemeChoice | undefined | null) {
  const [systemLight, setSystemLight] = useState(systemPrefersLight);
  useEffect(() => {
    if (choice !== 'auto') return;
    setSystemLight(systemPrefersLight());
    return watchSystemTheme(() => setSystemLight(systemPrefersLight()));
  }, [choice]);
  return themeAttrs(choice, systemLight);
}
