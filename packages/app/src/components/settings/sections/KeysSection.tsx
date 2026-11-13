// Settings > Keys: provider API keys, OpenCode A/B key profiles, rate-limit key automation, and removing keys.
// Secrets save on blur / Enter (never per keystroke, never on a Save button). OpenCode keys and the
// automation settings save through their own Tauri commands and tick the row when they succeed.
import { errorSentence } from '../../../lib/sayError';
import { t, useT } from '../../../i18n';
import { useCallback, useEffect, useState } from 'react';
import type { SettingsPatch } from '../../../lib/settings';
import { secretsApi, type ProviderSecretName } from '../../../lib/secrets';
import { tauri, type OpenCodeKeyStatus } from '../../../lib/tauri';
import { ApiKeyField } from '../ApiKeyField';
import { SecretControl } from '../controls';
import type { RowDef, SettingsEnv } from '../model';
import { Btn, FieldLabel, Note, SettingBlock, SettingRow, SettingToggle } from '../settings-ui';

type AutomationMode = 'auto_if_backup' | 'notify_only';

const KEYWORDS = 'api key anthropic openai openrouter opencode rotate rate limit keychain credential';

const OPENCODE_HINT = 'For OpenCode only. Never sent to the phone.';
/** The opt-in's name (founder decision 2026-10-15). Off by default; a person's earlier explicit choice is kept by the backend. */
const AUTOMATION_LABEL = 'Switch OpenCode keys at the limit';
const AUTOMATION_HINT = "Uses your other key when one is limited. Check your provider's terms.";
const RESTART_HINT = 'So it picks up the new key.';
const REMOVE_ALL_HINT = 'Deletes Anthropic, OpenAI and OpenRouter keys here. Agents lose access. OpenCode stays.';

// ---------- OpenCode key status (each row keeps its own copy) ----------

function useOpenCodeKeyStatus() {
  const [status, setStatus] = useState<OpenCodeKeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await tauri.getOpenCodeKeyStatus());
    } catch (e) {
      setError(errorSentence(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, setStatus, error, refresh };
}

// ---------- provider keys ----------

interface ProviderKeyDef {
  id: string;
  label: string;
  name: ProviderSecretName;
  placeholder: string;
  hint: string;
}

const PROVIDER_KEYS: ProviderKeyDef[] = [
  {
    id: 'key-anthropic',
    label: 'Anthropic API key',
    name: 'anthropic_api_key',
    placeholder: 'Paste your key',
    hint: 'Used by agents on Anthropic models.',
  },
  {
    id: 'key-openai',
    label: 'OpenAI API key',
    name: 'openai_api_key',
    placeholder: 'Paste your key',
    hint: 'Used by agents on OpenAI models.',
  },
  {
    id: 'key-openrouter',
    label: 'OpenRouter API key',
    name: 'openrouter_api_key',
    placeholder: 'Paste your key',
    hint: 'Used by agents that route through OpenRouter.',
  },
];

function ProviderKey({ env, def }: { env: SettingsEnv; def: ProviderKeyDef }) {
  const t = useT();
  const label = t(`settings.row.${def.id}.label` as 'settings.row.key-anthropic.label');
  return (
    <SettingBlock label={label} description={t(`settings.row.${def.id}.hint` as 'settings.row.key-anthropic.hint')}>
      <ApiKeyField
        label={label}
        name={def.name}
        placeholder={t('keys.paste')}
        fileValue={env.settings[def.name]}
        onFileChange={(value) => {
          const change: SettingsPatch = {};
          change[def.name] = value ?? null;
          return env.patch(change);
        }}
        onSaved={env.markSaved}
        onConfirmRemove={() =>
          env.confirm({
            title: t('keys.removeTitle', { name: def.label.replace(' API key', '') }),
            body: t('keys.removeBody'),
            confirmLabel: t('settings.remove'),
          })
        }
      />
    </SettingBlock>
  );
}

// ---------- OpenCode A / B keys ----------

function OpenCodeKeys({ env }: { env: SettingsEnv }) {
  const t = useT();
  const { status, error, refresh } = useOpenCodeKeyStatus();

  const profileLine = (id: 'a' | 'b') => {
    if (!status) return t('agentPage.checking');
    const profile = status.profiles.find((entry) => entry.id === id);
    if (!profile) return t('keys.unknown');
    if (!profile.configured) return t('keys.notSet');
    return status.active_profile === id ? t('keys.savedInUse') : t('keys.saved');
  };

  const save = async (id: 'a' | 'b', secret: string) => {
    env.setError(null);
    try {
      await tauri.setOpenCodeKeyProfile(id, secret, id === 'a' ? 'Primary' : 'Secondary');
      await refresh();
      env.markSaved();
    } catch (e) {
      env.setError(t('settings.notSaved', { reason: errorSentence(e) }));
    }
  };

  return (
    <SettingBlock label={t('settings.row.opencode-keys.label')} description={t('settings.row.opencode-keys.hint')}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <FieldLabel>{t('keys.mainKey', { state: profileLine('a') })}</FieldLabel>
            <SecretControl aria-label={t('keys.ocA')} placeholder={t('keys.paste')} onCommit={(secret) => save('a', secret)} />
          </div>
          <div className="space-y-1">
            <FieldLabel>{t('keys.spareKey', { state: profileLine('b') })}</FieldLabel>
            <SecretControl aria-label={t('keys.ocB')} placeholder={t('keys.paste')} onCommit={(secret) => save('b', secret)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn onClick={() => void refresh()}>{t('keys.check')}</Btn>
        </div>
        {error && <Note role="alert">{t('keys.readFailedOc', { error })}</Note>}
      </div>
    </SettingBlock>
  );
}

// ---------- key automation ----------

function AutomationMode({ env }: { env: SettingsEnv }) {
  const t = useT();
  const { status, setStatus, error } = useOpenCodeKeyStatus();
  const [busy, setBusy] = useState(false);

  const change = async (on: boolean) => {
    setBusy(true);
    env.setError(null);
    try {
      setStatus(await tauri.setOpenCodeAutomationSettings(on ? 'auto_if_backup' : 'notify_only', status?.restart_pane_on_rotate ?? true));
      env.markSaved();
    } catch (e) {
      env.setError(`Not saved: ${errorSentence(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingToggle
        label={t('settings.row.opencode-automation.label')}
        description={t('settings.row.opencode-automation.hint')}
        checked={status?.key_automation_mode === 'auto_if_backup'}
        disabled={!status || busy}
        onChange={(value) => void change(value)}
      />
      {error && <Note role="alert">{t('keys.readFailed', { error })}</Note>}
    </>
  );
}

function RestartPane({ env }: { env: SettingsEnv }) {
  const t = useT();
  const { status, setStatus } = useOpenCodeKeyStatus();
  const [busy, setBusy] = useState(false);

  const change = async (restart: boolean) => {
    setBusy(true);
    env.setError(null);
    const mode: AutomationMode = status?.key_automation_mode === 'auto_if_backup' ? 'auto_if_backup' : 'notify_only';
    try {
      setStatus(await tauri.setOpenCodeAutomationSettings(mode, restart));
      env.markSaved();
    } catch (e) {
      env.setError(`Not saved: ${errorSentence(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingToggle
      label={t('settings.row.opencode-restart.label')}
      description={t('settings.row.opencode-restart.hint')}
      checked={status?.restart_pane_on_rotate ?? true}
      disabled={!status || busy}
      onChange={(value) => void change(value)}
    />
  );
}

// ---------- remove all ----------

function RemoveAllKeys({ env }: { env: SettingsEnv }) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    env.setError(null);
    const ok = await env.confirm({
      title: t('keys.removeAllTitle'),
      body: t('keys.removeAllBody'),
      confirmLabel: t('keys.removeAllConfirm'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      if ((await secretsApi.storageInfo()).secure) {
        for (const def of PROVIDER_KEYS) await secretsApi.remove(def.name);
      }
      await env.patch({ anthropic_api_key: null, openai_api_key: null, openrouter_api_key: null });
      env.markSaved();
    } catch (e) {
      env.setError(t('keys.notRemoved', { reason: errorSentence(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label={t('settings.row.remove-all-keys.label')} description={t('settings.row.remove-all-keys.hint')}>
      <Btn disabled={busy} onClick={() => void run()}>
        {t('keys.removeBtn')}
      </Btn>
    </SettingRow>
  );
}

// ---------- the rows ----------

export const keysRows: RowDef[] = [
  ...PROVIDER_KEYS.map(
    (def): RowDef => ({
      id: def.id,
      label: def.label,
      hint: def.hint,
      keywords: KEYWORDS,
      group: 'Provider keys',
      render: (env) => <ProviderKey env={env} def={def} />,
    }),
  ),
  {
    id: 'opencode-keys',
    label: 'OpenCode keys (main and spare)',
    hint: OPENCODE_HINT,
    keywords: `${KEYWORDS} OpenCode key A OpenCode key B main spare refresh status check keys`,
    group: 'OpenCode keys',
    render: (env) => <OpenCodeKeys env={env} />,
  },
  {
    id: 'opencode-automation',
    labs: { name: 'Key switching', about: 'Move to your spare OpenCode key when one hits its rate limit.' },
    label: AUTOMATION_LABEL,
    hint: AUTOMATION_HINT,
    keywords: `${KEYWORDS} automation key automation mode switch backup second key terms`,
    group: 'OpenCode keys',
    render: (env) => <AutomationMode env={env} />,
  },
  {
    id: 'opencode-restart',
    label: 'Restart OpenCode after a key switch',
    hint: RESTART_HINT,
    keywords: `${KEYWORDS} restart pane rotate switch`,
    group: 'OpenCode keys',
    render: (env) => <RestartPane env={env} />,
  },
  {
    id: 'remove-all-keys',
    label: 'Remove all keys',
    hint: REMOVE_ALL_HINT,
    keywords: `${KEYWORDS} remove delete clear`,
    group: 'Remove keys',
    danger: true,
    render: (env) => <RemoveAllKeys env={env} />,
  },
];
