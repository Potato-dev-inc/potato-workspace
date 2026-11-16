// Settings > Agents > "Agents that agents start" (One type / Two types) and, only in Two types, "When an agent
// starts another agent" (Let it choose / Minion / Spin-off). Saved by the app, not by an agent, so an agent cannot decide
// what the agents it starts are.
import { useEffect, useState } from 'react';
import { setTwoTypesWording, useT } from '../../../i18n';
import {
  tauriStartedAgentsApi,
  type StartedAgentKind,
  type StartedAgentsApi,
  type StartedAgentsView,
  type StartedAgentTypes,
} from '../../../lib/agentRunMode';
import { errorSentence } from '../../../lib/sayError';
import { Popup } from '../controls';
import { SettingRow } from '../settings-ui';

export function StartedAgents({ api = tauriStartedAgentsApi, onSaved }: { api?: StartedAgentsApi; onSaved?: () => void }) {
  const t = useT();
  const [value, setValue] = useState<StartedAgentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .get()
      .then((v) => {
        if (!alive) return;
        setValue(v);
        setTwoTypesWording(v.types === 'two');
      })
      // No desktop shell (a browser preview): there is nothing to switch.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  if (value === null) return null;
  const save = async (change: Partial<StartedAgentsView>) => {
    setError(null);
    try {
      const saved = await api.set(change);
      setValue(saved);
      setTwoTypesWording(saved.types === 'two');
      onSaved?.();
    } catch (e) {
      setError(errorSentence(e));
    }
  };
  const typesLabel = t('startedAgents.typesLabel');
  const kindLabel = t('startedAgents.kindLabel');
  return (
    <>
      <SettingRow label={typesLabel} description={t('startedAgents.typesHelp')}>
        <Popup aria-label={typesLabel} value={value.types} onChange={(event) => void save({ types: event.target.value as StartedAgentTypes })}>
          <option value="one">{t('startedAgents.typesOne')}</option>
          <option value="two">{t('startedAgents.typesTwo')}</option>
        </Popup>
      </SettingRow>
      {value.types === 'two' && (
        <SettingRow label={kindLabel} description={t('startedAgents.kindHelp')}>
          <Popup aria-label={kindLabel} value={value.kind} onChange={(event) => void save({ kind: event.target.value as StartedAgentKind })}>
            <option value="agent_chooses">{t('startedAgents.kindChoose')}</option>
            <option value="minion">{t('startedAgents.kindMinion')}</option>
            <option value="spin_off">{t('startedAgents.kindSpinOff')}</option>
          </Popup>
        </SettingRow>
      )}
      {error && (
        <div role="alert" className="text-xs">
          {error}
        </div>
      )}
    </>
  );
}
