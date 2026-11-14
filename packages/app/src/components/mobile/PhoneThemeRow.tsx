// Settings row: Theme Auto / Light / Dark. Only this phone changes (lib/phone-theme.ts). One radio group so a screen reader says which is on.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { PHONE_THEME_EVENT, parsePhoneTheme, readPhoneTheme, setPhoneTheme, type PhoneTheme } from '../../lib/phone-theme';
import '../../styles/phone-link.css';

const THEMES: readonly PhoneTheme[] = ['auto', 'light', 'dark'];

export function PhoneThemeRow() {
  const t = useT();
  const [theme, setTheme] = useState<PhoneTheme>(readPhoneTheme);
  useEffect(() => {
    const on = (event: Event) => setTheme(parsePhoneTheme((event as CustomEvent<unknown>).detail));
    window.addEventListener(PHONE_THEME_EVENT, on);
    return () => window.removeEventListener(PHONE_THEME_EVENT, on);
  }, []);
  const label = (v: PhoneTheme) => (v === 'light' ? t('phone.theme.light') : v === 'dark' ? t('phone.theme.dark') : t('phone.theme.auto'));
  return (
    <div className="ph-group" data-testid="phone-theme">
      <div className="ph-row ph-textsize">
        <span className="ph-rowtext" id="ph-theme-label">{t('phone.theme.title')}</span>
        <div className="ph-seg" role="radiogroup" aria-labelledby="ph-theme-label">
          {THEMES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={theme === v} data-theme-choice={v} onClick={() => setPhoneTheme(v)}>
              {label(v)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
