// Settings > Agents > Helper agents: "Default model for helpers". One compact model dropdown per installed agent,
// the same picker and model list as the New agent page. A helper an agent starts without naming a model runs on
// this one. The New agent page keeps its own last-picked memory; the two never mix.
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { tauriModelOptionsApi, useModelOptions, type ModelOptionsApi } from '../../../lib/modelOptions';
import { ModelPicker } from '../../common/ModelPicker';
import { SettingBlock } from '../settings-ui';

export const HELPER_MODELS_LABEL = 'Default model for helpers';
export const HELPER_MODELS_HINT = "Helpers use this instead of the agent's Default model.";

/** The saved map as the settings hold it: only non-blank text values survive. */
export function cleanHelperModels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, model] of Object.entries(value as Record<string, unknown>)) {
    if (typeof model === 'string' && model.trim() !== '') out[id] = model.trim();
  }
  return out;
}

/** The map after `agentId` is set to `model` ('' removes it). Other agents' entries are kept. */
export function withHelperModel(map: Record<string, string>, agentId: string, model: string): Record<string, string> {
  const next = { ...map };
  if (model.trim()) next[agentId] = model.trim();
  else delete next[agentId];
  return next;
}

/**
 * An agent with no model to choose (a shell: no launch flag for a model, and no models listed) gets no row. Its answer
 * comes from the agent's own options, so nothing matches an agent by name. Still loading: the row waits.
 */
export function hasModelChoice(options: { terminal: boolean; models: readonly string[] }): boolean {
  return options.terminal || options.models.length > 0;
}

function AgentModelRow({ agentId, label, value, api, onChange, single }: { agentId: string; label: string; value: string; api: ModelOptionsApi; onChange: (model: string) => void; single: boolean }) {
  const state = useModelOptions(agentId, api);
  if (state.status === 'ready' && !hasModelChoice(state.options)) return null;
  return (
    <div className="st-helper-model">
      {!single && <span className="st-helper-model-name">{label}</span>}
      <ModelPicker testId={`helper-model-${agentId}`} label={`Default model for ${label} helpers`} state={state} value={value} onChange={onChange} defaultWord="Agent's default" />
    </div>
  );
}

/** `only`: show just this agent (its page in Settings > Agents). */
export function HelperDefaultModels({ saved, onChange, api = tauriModelOptionsApi, only }: { saved: unknown; onChange: (next: Record<string, string>) => void; api?: ModelOptionsApi; only?: string }) {
  const listing = useAgentRegistry();
  const map = cleanHelperModels(saved);
  const agents = listing.agents.filter((a) => a.installed && a.kind !== 'shell' && (!only || a.id === only));
  return (
    <SettingBlock label={HELPER_MODELS_LABEL} description={HELPER_MODELS_HINT}>
      {agents.length === 0 ? (
        <small>No agents are installed yet.</small>
      ) : (
        agents.map((agent) => (
          <AgentModelRow key={agent.id} agentId={agent.id} label={agent.label} value={map[agent.id] ?? ''} api={api} onChange={(model) => onChange(withHelperModel(map, agent.id, model))} single={Boolean(only)} />
        ))
      )}
    </SettingBlock>
  );
}
