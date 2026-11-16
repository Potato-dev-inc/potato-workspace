// One agent's "Keep ready" line on its own page (Settings > Agents > <agent>): a switch, and how many to keep started.
// Same backend as the global Keep agents ready row (`standby-pool.json`); this row also turns the global switch on
// when it is off, so one tick is enough.
import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { errorSentence } from '../../../lib/sayError';
import { tauri, type StandbyConfig, type StandbyStatus } from '../../../lib/tauri';
import { DEFAULT_STANDBY_CONFIG, preloadCount, preloadProviders, withPreloadCount, withPreloadEnabled } from '../../../lib/standby';
import { Switch } from '../controls';
import { Note, SettingRow } from '../settings-ui';
import { WarmCountStepper } from './WarmCountStepper';
import type { PreloadApi } from './PreloadSettings';

const DEFAULT_API: PreloadApi = {
  getStatus: () => tauri.standbyGetStatus(),
  setConfig: (config) => tauri.standbySetConfig(config),
};

export function KeepReadyRow({ agentId, label, api = DEFAULT_API }: { agentId: string; label: string; api?: PreloadApi }) {
  const t = useT();
  const registry = useAgentRegistry();
  const [status, setStatus] = useState<StandbyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.getStatus().then(setStatus, (e) => setError(errorSentence(e)));
  }, [api]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const agent = registry.agents.find((a) => a.id === agentId);
  const provider = agent?.modes && agent.standby ? preloadProviders([agent])[0] : undefined;
  if (!provider) return null;
  const config: StandbyConfig = status?.config ?? DEFAULT_STANDBY_CONFIG;
  const count = preloadCount(config, agentId);
  const on = config.preload.enabled && count > 0;
  const save = async (next: StandbyConfig) => {
    setError(null);
    try {
      setStatus(await api.setConfig(next));
    } catch (e) {
      setError(errorSentence(e));
    }
  };

  return (
    <>
      <SettingRow label={t('agentPage.keepReady')} description={provider.supported ? t('agentPage.keepReadyHelp', { label }) : provider.unsupportedNote}>
        {provider.supported && (
          <>
            {on && (
              <label className="flex items-center gap-2 text-sm text-pm-muted">
                {t('preload.keep')}
                <WarmCountStepper label={label} value={count} onChange={(next) => void save(withPreloadCount(config, agentId, next))} />
                {t('preload.warm')}
              </label>
            )}
            <Switch
              label={t('agentPage.keepReadyAria', { label })}
              checked={on}
              disabled={!status}
              onChange={(next) => void save(next ? withPreloadCount(withPreloadEnabled(config, true), agentId, 1) : withPreloadCount(config, agentId, 0))}
            />
          </>
        )}
      </SettingRow>
      {error && <Note role="alert">{error}</Note>}
    </>
  );
}
