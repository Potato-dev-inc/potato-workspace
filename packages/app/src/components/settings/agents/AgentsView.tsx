// The Agents list row: the list of agents, and (after a click or a deep link) one agent's page. Back returns to the list.
// Which page is open lives in agentTarget (the Settings window reads it to hide the rest of the Agents page).
// "Found on this computer" lives inside the Add an agent box above this row; it is not built a second time here.
import type { SettingsEnv } from '../model';
import { setOpenAgent, useOpenAgent } from './agentTarget';
import { AgentList } from './AgentList';
import { AgentPage, defaultPageApis, type AgentPageApis } from './AgentPage';
import { defaultRowsApi, useAgentRows, type AgentRowsApi } from './useAgentRows';
import './agents.css';

export function AgentsView({ env, rowsApi = defaultRowsApi, pageApis = defaultPageApis }: { env: SettingsEnv; rowsApi?: AgentRowsApi; pageApis?: AgentPageApis }) {
  const { rows, recheck } = useAgentRows(rowsApi);
  const openId = useOpenAgent();
  const open = openId ? rows.find((r) => r.id === openId) : undefined;
  if (open) return <AgentPage row={open} env={env} apis={pageApis} onBack={() => setOpenAgent(null)} onCheck={() => recheck(open.id)} />;
  return <AgentList rows={rows} onOpen={setOpenAgent} onCheck={recheck} />;
}
