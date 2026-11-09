// Settings > Agents > Helpers: "Helper agents" (shown / agent chooses / background) and "Keep helpers open when they
// finish" and "Close helpers when their agent closes". All are saved by the app, not by the agent, so an agent cannot talk its way around them.
import { useEffect, useState } from 'react';
import {
  CLOSE_WITH_AGENT_HINT,
  CLOSE_WITH_AGENT_LABEL,
  HELPER_AGENTS_HINT,
  HELPER_AGENTS_LABEL,
  HELPER_CHOICES,
  KEEP_OPEN_HINT,
  KEEP_OPEN_LABEL,
  tauriHelperAgentsApi,
  type HelperAgentsApi,
  type HelperVisibility,
} from '../../../lib/agentRunMode';
import { Popup } from '../controls';
import { SettingRow, SettingToggle } from '../settings-ui';

function useSaved<T>(load: () => Promise<T>, api: HelperAgentsApi) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((v) => alive && setValue(v))
      // No desktop shell (a browser preview): there is nothing to switch.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return { value, setValue, error, setError };
}

export function HelperAgentsChoice({
  api = tauriHelperAgentsApi,
  onSaved,
}: {
  api?: HelperAgentsApi;
  onSaved?: () => void;
}) {
  const { value, setValue, error, setError } = useSaved<HelperVisibility>(async () => (await api.get()).mode, api);
  if (value === null) return null;
  const save = async (next: HelperVisibility) => {
    setError(null);
    try {
      setValue((await api.set(next)).mode);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <SettingRow label={HELPER_AGENTS_LABEL} description={HELPER_AGENTS_HINT}>
        <Popup aria-label={HELPER_AGENTS_LABEL} value={value} onChange={(event) => void save(event.target.value as HelperVisibility)}>
          {HELPER_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Popup>
      </SettingRow>
      {error && (
        <div role="alert" className="text-xs">
          {error}
        </div>
      )}
    </>
  );
}

export function KeepHelpersOpenToggle({
  api = tauriHelperAgentsApi,
  onSaved,
}: {
  api?: HelperAgentsApi;
  onSaved?: () => void;
}) {
  const { value, setValue, error, setError } = useSaved<boolean>(async () => (await api.getKeepOpen()).on, api);
  if (value === null) return null;
  const save = async (next: boolean) => {
    setError(null);
    try {
      setValue((await api.setKeepOpen(next)).on);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <SettingToggle label={KEEP_OPEN_LABEL} description={KEEP_OPEN_HINT} checked={value} onChange={(v) => void save(v)} />
      {error && (
        <div role="alert" className="text-xs">
          {error}
        </div>
      )}
    </>
  );
}

export function CloseHelpersWithAgentToggle({
  api = tauriHelperAgentsApi,
  onSaved,
}: {
  api?: HelperAgentsApi;
  onSaved?: () => void;
}) {
  const { value, setValue, error, setError } = useSaved<boolean>(async () => (await api.getCloseWithAgent()).on, api);
  if (value === null) return null;
  const save = async (next: boolean) => {
    setError(null);
    try {
      setValue((await api.setCloseWithAgent(next)).on);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <SettingToggle label={CLOSE_WITH_AGENT_LABEL} description={CLOSE_WITH_AGENT_HINT} checked={value} onChange={(v) => void save(v)} />
      {error && (
        <div role="alert" className="text-xs">
          {error}
        </div>
      )}
    </>
  );
}
