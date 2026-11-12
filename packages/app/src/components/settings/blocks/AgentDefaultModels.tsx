// Settings > Agents > Default model: one compact model dropdown per agent that has models (a shell has none), the same
// picker and model list as the New agent page. The agent starts on this model when nothing else names one, in chats and
// in terminals. An agent that cannot take a model in a terminal says "Only for chats". Stored as the
// `agent_default_models` map (agent id -> model id, never the shown name).
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../../lib/modelOptions';
import { ModelPicker } from '../../common/ModelPicker';
import { SettingBlock } from '../settings-ui';
import { cleanHelperModels, hasModelChoice, withHelperModel } from './HelperModels';

export const AGENT_MODELS_LABEL = 'Default model';
export const AGENT_MODELS_HINT = 'The model each agent starts on, unless you pick another when you start it.';

function Row({ agentId, label, value, api, onChange }: { agentId: string; label: string; value: string; api: ModelOptionsApi; onChange: (model: string) => void }) {
  const state = useModelOptions(agentId, api);
  if (state.status === 'ready' && !hasModelChoice(state.options)) return null;
  const chatsOnly = state.status === 'ready' && !state.options.terminal;
  return (
    <div className="st-helper-model">
      <span className="st-helper-model-name">
        {label}
        {chatsOnly && <small className="st-helper-model-note"> · Only for chats</small>}
      </span>
      <ModelPicker testId={`agent-model-${agentId}`} label={`Default model for ${label}`} state={state} value={value} onChange={onChange} defaultWord="Agent's own default" />
    </div>
  );
}

export function AgentDefaultModels({ saved, onChange, api = tauriModelOptionsApi }: { saved: unknown; onChange: (next: Record<string, string>) => void; api?: ModelOptionsApi }) {
  const listing = useAgentRegistry();
  const map = cleanHelperModels(saved);
  const agents = listing.agents.filter((a) => a.installed && a.kind !== 'shell');
  return (
    <SettingBlock label={AGENT_MODELS_LABEL} description={AGENT_MODELS_HINT}>
      {agents.length === 0 ? (
        <small>No agents are installed yet.</small>
      ) : (
        agents.map((agent) => <Row key={agent.id} agentId={agent.id} label={agent.label} value={map[agent.id] ?? ''} api={api} onChange={(model) => onChange(withHelperModel(map, agent.id, model))} />)
      )}
    </SettingBlock>
  );
}
