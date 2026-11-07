// Settings > Agents > Helpers: "Allow hidden helpers". Off by default: a helper an agent starts is always a pane
// the person can watch. On: an agent that asks for `headless: true` may run its helper with no pane.
import { useEffect, useState } from 'react';
import {
  HIDDEN_HELPERS_HINT,
  HIDDEN_HELPERS_LABEL,
  tauriHiddenHelpersApi,
  type HiddenHelpersApi,
} from '../../../lib/agentRunMode';
import { SettingToggle } from '../settings-ui';

export function HiddenHelpersToggle({
  api = tauriHiddenHelpersApi,
  onSaved,
}: {
  api?: HiddenHelpersApi;
  onSaved?: () => void;
}) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get()
      .then((view) => alive && setAllowed(view.allowed))
      // No desktop shell (a browser preview): there is nothing to switch.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  if (allowed === null) return null;

  const save = async (next: boolean) => {
    setError(null);
    try {
      const view = await api.set(next);
      setAllowed(view.allowed);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <SettingToggle label={HIDDEN_HELPERS_LABEL} description={HIDDEN_HELPERS_HINT} checked={allowed} onChange={(value) => void save(value)} />
      {error && (
        <div role="alert" className="text-xs">
          {error}
        </div>
      )}
    </>
  );
}
