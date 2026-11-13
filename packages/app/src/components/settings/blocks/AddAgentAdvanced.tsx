// "Advanced" under the Add-an-agent box: the only place the technical words may appear. It holds the capture wizard
// (the person answers every question and approves the result), the manual chat command, Import, and Details of the last run.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { CHIPS, type AddAgentRun } from '../../../lib/addAgent';
import { tauriAgentDefinitionsApi, type AgentDefinitionsApi } from '../../../lib/agentDefinitions';
import type { WizardApi } from '../../../lib/agentWizard';
import { errorSentence } from '../../../lib/sayError';
import { Btn } from '../settings-ui';
import { AgentWizard, type Kind } from './AgentWizard';

export function AddAgentAdvanced({
  wizardApi,
  definitionsApi = tauriAgentDefinitionsApi,
  lastRun,
}: {
  wizardApi?: WizardApi;
  definitionsApi?: Pick<AgentDefinitionsApi, 'importDefinition'>;
  lastRun: AddAgentRun | null;
}) {
  const t = useT();
  const [wizard, setWizard] = useState<Kind | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const importFile = async () => {
    try {
      const next = await definitionsApi.importDefinition();
      if (next) setNote(t('addAgent.adv.imported'));
    } catch (e) {
      setNote(errorSentence(e));
    }
  };

  const caps = lastRun?.result?.caps ?? null;
  return (
    <div className="aa-adv" data-testid="add-agent-advanced">
      <p className="aa-quiet">{t('addAgent.adv.intro')}</p>
      <div className="aa-actions is-row">
        <Btn onClick={() => setWizard('terminal')}>{t('addAgent.adv.wizard')}</Btn>
        <Btn onClick={() => setWizard('chat')}>{t('addAgent.adv.chatCommand')}</Btn>
        <Btn onClick={() => void importFile()}>{t('addAgent.adv.import')}</Btn>
      </div>
      {note && (
        <p className="aa-note" role="status">
          {note}
        </p>
      )}
      <details className="aa-details">
        <summary>{t('addAgent.adv.details')}</summary>
        {!lastRun && <p className="aa-quiet">{t('addAgent.adv.nothing')}</p>}
        {lastRun && (
          <div className="aa-detail-body" data-raw="true" data-no-i18n>
            <p>
              {t('addAgent.adv.runFor', { input: lastRun.input, state: lastRun.state, level: caps ? t('addAgent.adv.level', { level: caps.level }) : '' })}
            </p>
            <ul>
              {lastRun.steps
                .filter((s) => s.detail)
                .map((s) => (
                  <li key={s.id}>
                    {s.id} ({s.state}): {s.detail}
                  </li>
                ))}
            </ul>
            {caps && (
              <ul>
                {CHIPS.map(({ key }) => (
                  <li key={key}>
                    {key}: {caps[key].value}
                    {caps[key].proof ? `, ${caps[key].proof}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </details>
      {wizard && (
        <AgentWizard
          api={wizardApi}
          initialKind={wizard}
          onClose={() => setWizard(null)}
          onApprove={() => {
            setWizard(null);
            setNote(t('addAgent.adv.saved'));
          }}
        />
      )}
    </div>
  );
}
