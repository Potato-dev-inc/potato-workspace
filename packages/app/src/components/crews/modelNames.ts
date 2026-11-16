// Model names as people read them. The agent's own list (the one the model menus use, `agent_model_options`) gives the
// name when it has one ("Opus 5.5"); without it a raw id is tidied: the part after a slash, words capitalised, a
// version like v4.1 kept ("opencode-go/deepseek-v4.1-flash" -> "DeepSeek V4.1 Flash"). A raw id is never the first choice.
import { useEffect, useMemo, useState } from 'react';
import { tauriModelOptionsApi, type ModelOptions, type ModelOptionsApi } from '../../lib/modelOptions';

const BRANDS: Record<string, string> = { deepseek: 'DeepSeek', gpt: 'GPT', glm: 'GLM', qwen: 'Qwen', kimi: 'Kimi', gemini: 'Gemini' };

/** A model id made readable. Pure. */
export function prettyModel(id: string): string {
  const tail = id.trim().split('/').pop() ?? id;
  return tail
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (BRANDS[lower]) return BRANDS[lower];
      if (/^v?\d+(\.\d+)*$/.test(lower)) return lower.replace(/^v/, 'V');
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

/** An agent's own name for a model, without a provider prefix ("opencode-go/DeepSeek V4.1 Flash 1017") or a trailing build number. */
export function tidyName(name: string): string {
  const tail = name.split('/').pop() ?? name;
  return tail.replace(/\s+\d{3,}$/, '').trim() || name;
}

/** The name for `model` of `agent`, from the agent's list when it is known. */
export type ModelNamer = (agent: string, model: string | null | undefined) => string;

export function namerFrom(lists: Record<string, ModelOptions | undefined>): ModelNamer {
  return (agent, model) => {
    if (!model) return '';
    const live = lists[agent]?.live?.find((m) => m.value === model);
    return live ? tidyName(live.name) : prettyModel(model);
  };
}

/** The namer for the agents a crew uses. It starts with tidied ids and improves as each agent's list arrives. */
export function useModelNamer(agents: string[], api: ModelOptionsApi = tauriModelOptionsApi): ModelNamer {
  const [lists, setLists] = useState<Record<string, ModelOptions | undefined>>({});
  const key = [...new Set(agents)].sort().join('|');
  useEffect(() => {
    let live = true;
    for (const agent of key ? key.split('|') : []) {
      api
        .get(agent)
        .then((options) => live && setLists((prev) => ({ ...prev, [agent]: options })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [api, key]);
  return useMemo(() => namerFrom(lists), [lists]);
}
