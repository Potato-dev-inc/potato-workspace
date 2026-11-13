// Settings > Look and feel > Language: Automatic (follows Windows), English or Traditional Chinese.
// Saves to the settings file (`ui_language`) and switches the whole app live, no restart.
import { LANGUAGE_PREFS, isLanguagePref, setLanguagePref, useT, type LanguagePref } from '../../../i18n';
import type { RowDef, SettingsEnv } from '../model';
import { FieldSelect, SettingRow } from '../settings-ui';

function optionLabel(pref: LanguagePref): string {
  // Each language is always written in itself, so a person can find theirs even in a language they cannot read.
  return pref === 'en' ? 'English' : pref === 'zh-TW' ? '繁體中文' : '';
}

function LanguageRow({ env }: { env: SettingsEnv }) {
  const t = useT();
  const saved = isLanguagePref(env.settings.ui_language) ? env.settings.ui_language : 'auto';
  return (
    <SettingRow label={t('lookFeel.language.label')} description={t('lookFeel.language.hint')}>
      <FieldSelect
        aria-label={t('lookFeel.language.label')}
        value={saved}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLanguagePref(next)) return;
          setLanguagePref(next);
          void env.patch({ ui_language: next });
        }}
      >
        {LANGUAGE_PREFS.map((pref) => (
          <option key={pref} value={pref}>
            {pref === 'auto' ? t('lookFeel.language.auto') : optionLabel(pref)}
          </option>
        ))}
      </FieldSelect>
    </SettingRow>
  );
}

export const languageRow: RowDef = {
  id: 'language',
  label: 'Language',
  hint: 'Automatic follows Windows.',
  keywords: 'language locale chinese traditional taiwan english translate zh-tw 繁體中文 語言',
  group: 'Appearance',
  render: (env) => <LanguageRow env={env} />,
};
