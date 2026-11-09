// Settings > Agents: "Agents in the New agent menu". One row with an Edit button; Edit opens the same editor the
// New agent menu's "Edit list…" opens. The agents come from the registry, so an agent added later shows up here too.
import { useState } from 'react';
import { paneMenuEntries, useAgentRegistry } from '../../../lib/agentRegistry';
import { HiddenAgentsEditor } from '../../cockpit/newagent/HiddenAgentsEditor';
import { SettingRow } from '../settings-ui';

export function HiddenAgentsRow() {
  const listing = useAgentRegistry();
  const [open, setOpen] = useState(false);
  const agents = paneMenuEntries(listing).map((e) => ({ type: e.type, label: e.label }));
  return (
    <>
      <SettingRow label="Agents in the New agent menu" description="Hide the agents you never use. A hidden agent stays installed.">
        <button type="button" className="ck-hidden-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Done' : 'Edit'}
        </button>
      </SettingRow>
      {open && <HiddenAgentsEditor entries={agents} onBack={() => setOpen(false)} backLabel="Done" />}
    </>
  );
}
