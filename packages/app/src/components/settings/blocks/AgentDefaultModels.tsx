// Settings > Agents > Default model: one compact model dropdown per agent that has models (a shell has none), the same
// picker and model list as the New agent page. The agent starts on this model when nothing else names one, in chats and
// in terminals. An agent that cannot take a model in a terminal says "Only for chats". Stored as the
// `agent_default_models` map (agent id -> model id, never the shown name).
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { useT } from '../../../i18n';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../../lib/modelOptions';
import { ModelPicker } from '../../common/ModelPicker';
import { SettingBlock } from '../settings-ui';
import { cleanHelperModels, hasModelChoice, withHelperModel } from './HelperModels';

export const AGENT_MODELS_LABEL = 'Default model';
export const AGENT_MODELS_HINT = 'The model each agent starts on, unless you pick another when you start it.';

function Row({ agentId, label, value, api, onChange, single }: { agentId: string; label: string; value: string; api: ModelOptionsApi; onChange: (model: string) => void; single: boolean }) {
  const t = useT();
  const state = useModelOptions(agentId, api);
  if (state.status === 'ready' && !hasModelChoice(state.options)) return null;
  const chatsOnly = state.status === 'ready' && !state.options.terminal;
  return (
    <div className="st-helper-model">
      {/* On an agent's own page the name is already the title. */}
      {(!single || chatsOnly) && (
        <span className="st-helper-model-name">
          {single ? '' : label}
          {chatsOnly && <small className="st-helper-model-note">{single ? t('models.chatsOnly') : ` · ${t('models.chatsOnly')}`}</small>}
        </span>
      )}
      <ModelPicker testId={`agent-model-${agentId}`} label={t('models.defaultFor', { label })} state={state} value={value} onChange={onChange} defaultWord={t('models.ownDefault')} />
    </div>
  );
}

/** `only`: show just this agent (its page in Settings > Agents). */
export function AgentDefaultModels({ saved, onChange, api = tauriModelOptionsApi, only }: { saved: unknown; onChange: (next: Record<string, string>) => void; api?: ModelOptionsApi; only?: string }) {
  const t = useT();
  const listing = useAgentRegistry();
  const map = cleanHelperModels(saved);
  const agents = listing.agents.filter((a) => a.installed && a.kind !== 'shell' && (!only || a.id === only));
  return (
    <SettingBlock label={t('settings.row.agent-default-models.label')} description={t('settings.row.agent-default-models.hint')}>
      {agents.length === 0 ? (
        <small>{t('models.noneInstalled')}</small>
      ) : (
        agents.map((agent) => <Row key={agent.id} agentId={agent.id} label={agent.label} value={map[agent.id] ?? ''} api={api} onChange={(model) => onChange(withHelperModel(map, agent.id, model))} single={Boolean(only)} />)
      )}
    </SettingBlock>
  );
}
