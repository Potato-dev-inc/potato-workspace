// A small in-house translation layer (no dependency). English is the source of truth (en.ts, typed keys);
// zh-TW.ts has the same keys, and a missing one falls back to English, never to the key itself.
//   t('sidebar.newAgent')                      plain text
//   t('inbox.count', { n: 3 })                 "{n}" is replaced
//   t('inbox.items', { count: 3 })             picks `inbox.items_one` / `inbox.items_other` (English rule; zh-TW has no plural)
// React: `const t = useT()` re-renders the component when the language changes.
import { useCallback, useSyncExternalStore } from 'react';
import { en, type MessageKey, type PluralKey } from './en';
import { zhTW } from './zh-TW';

export type LanguagePref = 'auto' | 'en' | 'zh-TW';
export type Language = 'en' | 'zh-TW';
export type { MessageKey } from './en';

export const LANGUAGE_PREFS: readonly LanguagePref[] = ['auto', 'en', 'zh-TW'];
export const LANGUAGE_STORAGE_KEY = 'pm-ui-language';

export type Vars = Record<string, string | number>;

const catalogs: Record<Language, Partial<Record<string, string>>> = { en, 'zh-TW': zhTW };

let pref: LanguagePref = 'auto';
let systemLanguage: string | null = null;
let current: Language = 'en';
const listeners = new Set<() => void>();

export function isLanguagePref(value: unknown): value is LanguagePref {
  return value === 'auto' || value === 'en' || value === 'zh-TW';
}

/** Which of our languages a browser/Windows language tag maps to. Traditional Chinese only; anything else is English. */
export function languageFromTag(tag: string | null | undefined): Language {
  const lower = (tag ?? '').toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-mo' || lower.startsWith('zh-hant')) return 'zh-TW';
  return 'en';
}

function systemTag(): string | null {
  if (systemLanguage !== null) return systemLanguage;
  return typeof navigator !== 'undefined' ? navigator.language : null;
}

/** The language a preference means right now ("auto" follows the system). */
export function resolveLanguage(value: LanguagePref, system: string | null = systemTag()): Language {
  return value === 'auto' ? languageFromTag(system) : value;
}

function apply(): void {
  const next = resolveLanguage(pref);
  const changed = next !== current;
  current = next;
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = next === 'zh-TW' ? 'zh-TW' : 'en';
  if (changed) listeners.forEach((l) => l());
}

function readStored(): LanguagePref {
  try {
    const raw = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePref(raw) ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

/** Set the preference (live, no restart). `remember` also keeps it for the next start of this window. */
export function setLanguagePref(next: LanguagePref, remember = true): void {
  pref = next;
  if (remember) {
    try {
      globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* private mode: the saved setting still wins on the next load */
    }
  }
  apply();
}

export function getLanguagePref(): LanguagePref {
  return pref;
}

export function getLanguage(): Language {
  return current;
}

/** Tests: pretend Windows is set to this language tag (null = use the real one). */
export function setSystemLanguageForTests(tag: string | null): void {
  systemLanguage = tag;
  apply();
}

function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

function lookup(lang: Language, key: string, count: number | undefined): string | undefined {
  const table = catalogs[lang];
  if (count !== undefined) {
    const plural = table[`${key}_${count === 1 && lang === 'en' ? 'one' : 'other'}`];
    if (plural !== undefined) return plural;
  }
  return table[key];
}

/** Translate. A key missing in the current language falls back to English; a key missing everywhere gives the key. */
export function t(key: MessageKey | PluralKey, vars?: Vars): string {
  const count = typeof vars?.count === 'number' ? vars.count : undefined;
  const text = lookup(current, key, count) ?? (current === 'en' ? undefined : lookup('en', key, count)) ?? key;
  return interpolate(text, vars);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The translate function for React: the component re-renders when the language changes. */
export function useT(): typeof t {
  const lang = useSyncExternalStore(subscribe, getLanguage, getLanguage);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `lang` is the reason to make a new function
  return useCallback(((key, vars) => t(key, vars)) as typeof t, [lang]);
}

/** The current language as React state (for `lang` attributes and number/date formatting). */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

// A window starts with what it remembered; the saved setting (Settings > Look and feel > Language) is read right after.
pref = readStored();
apply();
