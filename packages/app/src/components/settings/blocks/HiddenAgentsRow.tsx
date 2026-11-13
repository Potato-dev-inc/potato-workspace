// Settings > Agents: "Agents in the New agent menu". One row with an Edit button; Edit opens the same editor the
// New agent menu's "Edit list…" opens. The agents come from the registry, so an agent added later shows up here too.
import { useState } from 'react';
import { t, useT } from '../../../i18n';
import { paneMenuEntries, useAgentRegistry } from '../../../lib/agentRegistry';
import { HiddenAgentsEditor } from '../../cockpit/newagent/HiddenAgentsEditor';
import { SettingRow } from '../settings-ui';

export function HiddenAgentsRow() {
  const t = useT();
  const listing = useAgentRegistry();
  const [open, setOpen] = useState(false);
  const agents = paneMenuEntries(listing).map((e) => ({ type: e.type, label: e.label }));
  return (
    <>
      <SettingRow label={t('settings.row.hidden-agents.label')} description={t('hiddenAgents.help')}>
        <button type="button" className="ck-hidden-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? t('lend.request.done') : t('lend.edit')}
        </button>
      </SettingRow>
      {open && <HiddenAgentsEditor entries={agents} onBack={() => setOpen(false)} backLabel={t('lend.request.done')} />}
    </>
  );
}
