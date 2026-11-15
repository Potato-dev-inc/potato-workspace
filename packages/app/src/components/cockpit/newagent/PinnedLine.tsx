// What every new agent starts with, on the New agent page: the model, the mode, Force yes, the notes and the fences the
// person pinned (Settings > Agents > Rules for agents) for this agent in this project. One quiet line under the message
// box; nothing is drawn when nothing is pinned. The backend applies the pins when the agent starts; this only shows them.
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { nothingPinned, tauriAgentRulesApi, type AgentRulesApi, type EffectivePins } from '../../../lib/agentRules';
import { openSettingsAt } from '../../../lib/openSettingsAt';

/** The pins of `agentId` in `project`, read again when either changes. `null` until known (or when the app cannot say). */
export function usePinnedRules(agentId: string | null, project: string | null, api: Pick<AgentRulesApi, 'effective'> = tauriAgentRulesApi): EffectivePins | null {
  const [pins, setPins] = useState<EffectivePins | null>(null);
  useEffect(() => {
    if (!agentId) {
      setPins(null);
      return undefined;
    }
    let live = true;
    api
      .effective(agentId, project)
      .then((next) => live && setPins(next))
      .catch(() => live && setPins(null));
    return () => {
      live = false;
    };
  }, [api, agentId, project]);
  return pins;
}

export function PinnedLine({ pins, onChange = () => openSettingsAt('agents', 'agent-rules') }: { pins: EffectivePins | null; onChange?: () => void }) {
  const t = useT();
  if (!pins || nothingPinned(pins)) return null;
  return (
    <div className="fy-pinned" data-testid="na-pinned" aria-label={t('newAgent.pinnedTitle')}>
      <span>{t('newAgent.pinnedTitle')}:</span>
      {pins.model && <span className="ck-chip-label">{t('newAgent.pinnedModel', { value: pins.model })}</span>}
      {pins.mode && <span className="ck-chip-label">{t('newAgent.pinnedMode', { value: pins.mode })}</span>}
      {pins.force_yes && <span className="ck-chip-label is-risk">{t('newAgent.pinnedForceYes')}</span>}
      {pins.fences.length > 0 && <span className="ck-chip-label">{t('newAgent.pinnedFences', { count: pins.fences.length })}</span>}
      {pins.notes && (
        <span className="ck-chip-label" title={pins.notes}>
          {t('newAgent.pinnedNotes')}
        </span>
      )}
      <button type="button" className="ck-link" data-testid="na-pinned-change" onClick={onChange}>
        {t('newAgent.pinnedChange')}
      </button>
    </div>
  );
}
