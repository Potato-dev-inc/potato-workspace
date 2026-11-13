// Settings > General > Labs > Ask bar: the global shortcut that opens a small bar to ask an agent a quick question.
// It saves through its own commands (`askbar_settings_get/set`), then flashes the row's "Saved" tick.
import { errorSentence } from '../../../lib/sayError';
import { useT } from '../../../i18n';
import { useEffect, useState } from 'react';
import { ASKBAR_SHORTCUTS, tauriAskbarApi, type AskbarAgent, type AskbarApi, type AskbarSettings } from '../../../lib/askbar';
import { FieldSelect, SettingRow, SettingToggle } from '../settings-ui';

export function AskBarSettingsBlock({ api = tauriAskbarApi, onSaved }: { api?: AskbarApi; onSaved?: () => void }) {
  const t = useT();
  const [s, setS] = useState<AskbarSettings | null>(null);
  const [agents, setAgents] = useState<AskbarAgent[]>([]);
  useEffect(() => {
    api.settingsGet().then(setS).catch(() => {});
    api.agents().then(setAgents).catch(() => {});
  }, [api]);
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  const save = (next: AskbarSettings) => {
    const before = s;
    setError(null);
    setS(next);
    api
      .settingsSet(next)
      .then((saved) => {
        setS(saved);
        onSaved?.();
      })
      .catch((e: unknown) => {
        setS(before); // put the old value back: it was not saved
        setError(t('settings.notSaved', { reason: errorSentence(e) }));
      });
  };
  return (
    <>
      {error && (
        <p role="alert" className="text-xs text-pm-err">
          {error}
        </p>
      )}
      <SettingToggle
        label={t('settings.row.ask-bar.label')}
        description={t('askBar.help')}
        checked={s.enabled}
        onChange={(enabled) => save({ ...s, enabled })}
      />
      <SettingRow label={t('askBar.shortcut')} description={t('askBar.shortcutHelp')}>
        <FieldSelect aria-label={t('askBar.shortcut')} value={s.shortcut} disabled={!s.enabled} onChange={(e) => save({ ...s, shortcut: e.target.value })}>
          {ASKBAR_SHORTCUTS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      <SettingRow label={t('askBar.agent')} description={t('askBar.agentHelp')}>
        <FieldSelect
          aria-label={t('askBar.agent')}
          value={s.default_agent ?? ''}
          disabled={!s.enabled}
          onChange={(e) => save({ ...s, default_agent: e.target.value || null })}
        >
          <option value="">{t('askBar.lastUsed')}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      <SettingToggle
        label={t('askBar.clipboard')}
        description={t('askBar.clipboardHelp')}
        checked={s.attach_clipboard_default}
        onChange={(attach_clipboard_default) => save({ ...s, attach_clipboard_default })}
      />
    </>
  );
}
