// Settings > Preload: keep a warm agent (CLI at its input box + a hidden pane window) per ticked
// provider, so opening a pane for it is instant. Backed by the standby pool (`standby-pool.json`).
import { errorSentence } from '../../../lib/sayError';
import { useT } from '../../../i18n';
import { useCallback, useEffect, useState } from 'react';
import { tauri, type StandbyConfig, type StandbyStatus } from '../../../lib/tauri';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import {
  DEFAULT_STANDBY_CONFIG,
  MAX_WARM_PER_PROVIDER,
  followWhyText,
  formatDuration,
  holdKeyLabel,
  holdReasonText,
  preloadCount,
  preloadProviders,
  summarizePreload,
  idleDisplayValue,
  idleUnitFor,
  withIdleValue,
  type IdleUnit,
  withPreloadCount,
  withPreloadEnabled,
} from '../../../lib/standby';
import { NumberControl, Popup } from '../controls';
import { SettingBlock, SettingToggle } from '../settings-ui';

export interface PreloadApi {
  getStatus: () => Promise<StandbyStatus | null>;
  setConfig: (config: StandbyConfig) => Promise<StandbyStatus | null>;
}

const DEFAULT_API: PreloadApi = {
  getStatus: () => tauri.standbyGetStatus(),
  setConfig: (config) => tauri.standbySetConfig(config),
};

export function PreloadSettings({ api = DEFAULT_API, onSaved }: { api?: PreloadApi; onSaved?: () => void }) {
  const t = useT();
  const registry = useAgentRegistry();
  const [status, setStatus] = useState<StandbyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getStatus());
    } catch (e) {
      setError(errorSentence(e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const config: StandbyConfig = status?.config ?? DEFAULT_STANDBY_CONFIG;
  const save = async (next: StandbyConfig) => {
    setError(null);
    try {
      setStatus(await api.setConfig(next));
      onSaved?.();
    } catch (e) {
      setError(errorSentence(e));
    }
  };
  const providers = preloadProviders(registry.agents);

  return (
    <>
      <SettingToggle
        label={t('preload.label')}
        description={t('preload.help')}
        checked={config.preload.enabled}
        onChange={(value) => void save(withPreloadEnabled(config, value))}
      />
      <SettingBlock
        label={t('preload.agentsLabel')}
        description={t('preload.agentsHelp')}
      >
        <div className="space-y-2" data-testid="preload-providers">
          {providers.map((provider) => {
            const count = preloadCount(config, provider.id);
            return (
              <div key={provider.id} className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex w-56 items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    aria-label={t('preload.keepWarm', { label: provider.label })}
                    disabled={!provider.supported || !status}
                    checked={count > 0}
                    onChange={(event) => void save(withPreloadCount(config, provider.id, event.target.checked ? 1 : 0))}
                  />
                  {provider.label}
                  {provider.experimental && (
                    <span
                      className="text-xs font-normal text-pm-muted"
                      title={t('preload.experimentalTip')}
                    >
                      {t('preload.experimental')}
                    </span>
                  )}
                </label>
                {provider.supported ? (
                  <label className="flex items-center gap-2 text-pm-muted">
                    {t('preload.keep')}
                    <select
                      aria-label={t('preload.warmCount', { label: provider.label })}
                      disabled={count === 0}
                      value={count || 1}
                      onChange={(event) => void save(withPreloadCount(config, provider.id, Number(event.target.value)))}
                    >
                      {Array.from({ length: MAX_WARM_PER_PROVIDER }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    {t('preload.warm')}
                  </label>
                ) : (
                  <span className="text-xs text-pm-muted">{provider.unsupportedNote}</span>
                )}
              </div>
            );
          })}
          {!status && <p className="text-sm text-pm-muted">{t('tunnel.status.desktopOnly')}</p>}
        </div>
      </SettingBlock>
      <SettingBlock
        label={t('preload.idle')}
        description={t('preload.idleHelp', { time: formatDuration(config.idle_timeout_secs * 1000) })}
      >
        <IdleTimeoutField config={config} onChange={save} />
      </SettingBlock>
      <SettingBlock label={t('preload.status')} description={summarizePreload(status)}>
        <div className="space-y-2 text-sm">
          {error && <p className="text-pm-text">{error}</p>}
          {status?.following && (
            <p className="text-sm text-pm-text" data-testid="preload-following">
              {t('preload.following')} <span className="font-mono text-xs">{status.following.project}</span> — {followWhyText(status.following.why)}
            </p>
          )}
          {status?.following?.not_warmed.map((item) => (
            <p key={item.agent_type} className="text-sm text-pm-text" data-testid={`preload-not-warmed-${item.agent_type}`}>
              {t('preload.notWarmed')} <span className="font-mono text-xs">{status.following?.project}</span>{' '}
              {t('preload.needsTrust', { agent: registry.agents.find((a) => a.id === item.agent_type)?.label ?? item.agent_type })}
              <span className="text-pm-muted"> {t('preload.openOnce')}</span>
            </p>
          ))}
          {status?.standbys
            .filter((standby) => !standby.headless)
            .map((standby) => (
              <div key={standby.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-pm-border px-3 py-2">
                <span className="font-medium">{registry.agents.find((a) => a.id === standby.agent_type)?.label ?? standby.agent_type}</span>
                <span className="font-mono text-xs text-pm-muted">{standby.project}</span>
                <span>{standby.state}</span>
                {standby.idle_expires_in_ms != null && (
                  <span className="text-pm-muted">{t('preload.closesIn', { time: formatDuration(standby.idle_expires_in_ms) })}</span>
                )}
              </div>
            ))}
          {status?.agents_blocked?.map((agent) => (
            <p key={agent.agent_type} className="text-sm text-pm-text" data-testid={`preload-blocked-${agent.agent_type}`}>
              {t('preload.cantStay', { agent: registry.agents.find((a) => a.id === agent.agent_type)?.label ?? agent.agent_type, message: agent.message })}{' '}
              <span className="text-pm-muted">
                {agent.reason === 'untested_version'
                  ? t('preload.untested')
                  : agent.cold
                    ? t('preload.untilOpen')
                    : t('preload.tryingAgain', { time: formatDuration(agent.retry_in_ms) })}
              </span>
            </p>
          ))}
          {status?.blocked.map((blocked) => (
            <p key={blocked.key} className="text-xs text-pm-muted">
              {t('preload.heldBack', { key: holdKeyLabel(blocked.key), reason: holdReasonText(blocked.reason), extra: blocked.cold ? t('preload.warmsAgain') : t('preload.retryIn', { time: formatDuration(blocked.retry_in_ms) }) })}
            </p>
          ))}
        </div>
      </SettingBlock>
    </>
  );
}

/**
 * The idle timeout in the unit that shows the stored value exactly (a 5 second value reads "5 seconds",
 * not "0 minutes"). Showing it never rewrites it; only typing a number or switching the unit does.
 */
function IdleTimeoutField({ config, onChange }: { config: StandbyConfig; onChange: (next: StandbyConfig) => Promise<void> | void }) {
  const t = useT();
  const secs = config.idle_timeout_secs;
  const [unit, setUnit] = useState<IdleUnit>(() => idleUnitFor(secs));
  // A change from outside (another window, a reload) that no longer fits the shown unit moves the unit.
  useEffect(() => {
    setUnit((current) => (current === 'minutes' && idleUnitFor(secs) === 'seconds' ? 'seconds' : current));
  }, [secs]);
  return (
    <div className="flex max-w-xs items-end gap-2">
      <div className="min-w-0">
        <NumberControl
          min={unit === 'minutes' ? 1 : 5}
          max={unit === 'minutes' ? 1440 : 86400}
          aria-label={t('preload.idleAria', { unit: t(`preload.unit.${unit}`) })}
          value={idleDisplayValue(secs, unit)}
          onCommit={(value) => onChange(withIdleValue(config, value, unit))}
        />
      </div>
      <Popup
        aria-label={t('preload.unitAria')}
        value={unit}
        onChange={(event) => {
          const next = event.target.value as IdleUnit;
          setUnit(next);
          // Seconds -> minutes can only show whole minutes, so the saved value follows what is shown.
          if (next === 'minutes' && idleUnitFor(secs) === 'seconds') {
            void onChange(withIdleValue(config, idleDisplayValue(secs, 'minutes'), 'minutes'));
          }
        }}
      >
        <option value="seconds">{t('preload.unit.seconds')}</option>
        <option value="minutes">{t('preload.unit.minutes')}</option>
      </Popup>
    </div>
  );
}
