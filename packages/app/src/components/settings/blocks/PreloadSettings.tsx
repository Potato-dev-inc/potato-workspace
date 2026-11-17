// Settings > Preload: keep a warm agent (CLI at its input box + a hidden pane window) per ticked
// provider, so opening a pane for it is instant. Backed by the standby pool (`standby-pool.json`).
import { errorSentence } from '../../../lib/sayError';
import { useT, type MessageKey } from '../../../i18n';
import { tauriStandbyHelpersApi, useStandbyHelpers, type StandbyHelpersApi } from '../../../lib/standbyHelpers';
import { useCallback, useEffect, useState } from 'react';
import { tauri, type StandbyConfig, type StandbyStatus } from '../../../lib/tauri';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { useHiddenAgents } from '../../../lib/hiddenAgents';
import {
  DEFAULT_STANDBY_CONFIG,
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
import { WarmCountStepper } from './WarmCountStepper';
import { Fold, SettingBlock, SettingToggle } from '../settings-ui';

export interface PreloadApi {
  getStatus: () => Promise<StandbyStatus | null>;
  setConfig: (config: StandbyConfig) => Promise<StandbyStatus | null>;
}

const DEFAULT_API: PreloadApi = {
  getStatus: () => tauri.standbyGetStatus(),
  setConfig: (config) => tauri.standbySetConfig(config),
};

/** One global switch (idle time under Details). Which agents stay ready is each agent page's Keep ready line (KeepReadyRow). */
export function PreloadSettings({ api = DEFAULT_API, helpersApi = tauriStandbyHelpersApi, onSaved }: { api?: PreloadApi; helpersApi?: StandbyHelpersApi; onSaved?: () => void }) {
  const t = useT();
  const { view: helpersView, apply: applyHelpers } = useStandbyHelpers(helpersApi);
  const neverClose = !!helpersView.never_close;
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
  const agentName = (id: string) => registry.agents.find((a) => a.id === id)?.label ?? id;
  // What to do, in one short line, for each reason a warm-up cannot stay.
  const actFor = (reason: string): string => {
    const key = (['dialog', 'needs_attention', 'untested_version'] as const).find((r) => r === reason);
    return t(key ? (`preload.act.${key}` as MessageKey) : 'preload.act.other');
  };
  const hasDetails = !!status && (!!status.following || status.blocked.length > 0 || (status.agents_blocked?.length ?? 0) > 0);
  const { hidden } = useHiddenAgents();
  // An agent turned off in Settings > Agents > Definitions is not offered here (unless it is already kept warm).
  const providers = preloadProviders(registry.agents).filter((p) => !hidden.includes(p.id) || preloadCount(config, p.id) > 0);

  return (
    <>
      <SettingToggle
        label={t('preload.label')}
        description={t('preload.help')}
        checked={config.preload.enabled}
        onChange={(value) => {
          if (!value) return void save(withPreloadEnabled(config, false));
          // One switch: turning it on keeps the first agent that can be kept warm, unless one is already chosen.
          const chosen = providers.some((p) => preloadCount(config, p.id) > 0);
          const first = providers.find((p) => p.supported);
          const on = withPreloadEnabled(config, true);
          void save(chosen || !first ? on : withPreloadCount(on, first.id, 1));
        }}
      />
      <SettingToggle
        label={t('preload.neverClose')}
        description={t('preload.neverCloseHelp')}
        checked={neverClose}
        onChange={(value) => {
          void (helpersApi.setNeverClose?.(value) ?? Promise.resolve(null)).then((next) => applyHelpers(next)).catch((e) => setError(errorSentence(e)));
        }}
      />
      <Fold label={t('settings.details')}>
      <SettingBlock
        label={t('preload.idle')}
        description={t('preload.idleHelp', { time: formatDuration(config.idle_timeout_secs * 1000) })}
      >
        <IdleTimeoutField config={config} onChange={save} />
      </SettingBlock>
      </Fold>
      <SettingBlock label={t('preload.status')} description={summarizePreload(status)}>
        <div className="space-y-2 text-sm">
          {error && <p className="text-pm-text">{error}</p>}
          {/* One short line per warm-up with what to do. The long reasons and the folders are folded under "More details". */}
          {status?.agents_blocked?.map((agent) => (
            <p key={`short-${agent.agent_type}`} className="text-sm text-pm-text" data-testid={`preload-short-${agent.agent_type}`}>
              <span className="font-medium">{agentName(agent.agent_type)}</span> {actFor(agent.reason)}
            </p>
          ))}
          {status?.following?.not_warmed.map((item) => (
            <p key={`short-trust-${item.agent_type}`} className="text-sm text-pm-text" data-testid={`preload-short-trust-${item.agent_type}`}>
              <span className="font-medium">{agentName(item.agent_type)}</span> {t('preload.act.needs_trust')}
            </p>
          ))}
          {status?.standbys
            .filter((standby) => !standby.headless)
            .map((standby) => (
              <div key={standby.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-pm-border px-3 py-2">
                <span className="font-medium">{registry.agents.find((a) => a.id === standby.agent_type)?.label ?? standby.agent_type}</span>
                <span className="font-mono text-xs text-pm-muted">{standby.project}</span>
                <span>{standby.state}</span>
                {neverClose ? (
                  <span className="text-pm-muted">{t('preload.staysReady')}</span>
                ) : (
                  standby.idle_expires_in_ms != null && <span className="text-pm-muted">{t('preload.closesIn', { time: formatDuration(standby.idle_expires_in_ms) })}</span>
                )}
              </div>
            ))}
          {hasDetails && (
          <details data-testid="preload-details">
            <summary className="cursor-pointer text-xs text-pm-muted">{t('preload.moreDetails')}</summary>
            <div className="mt-2 space-y-2">
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
          </details>
          )}
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
