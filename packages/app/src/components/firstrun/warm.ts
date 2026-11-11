// Start warm agents while the person is still on the first screen, so the demo opens fast. This is the
// same pool Settings > Preload drives (`standby_set_config`, `standby_set_current_project`); nothing new
// runs. A person who already set Preload up keeps their choices; only the followed folder is told.
import { preloadProviders, withPreloadCount, withPreloadEnabled } from '../../lib/standby';
import { peekAgentRegistry } from '../../lib/agentRegistry';
import { tauri } from '../../lib/tauri';
import type { StandbyConfig, StandbyStatus } from '../../lib/tauri-types';

export interface WarmApi {
  status: () => Promise<StandbyStatus | null>;
  setConfig: (config: StandbyConfig) => Promise<StandbyStatus | null>;
  setProject: (path: string) => Promise<boolean>;
  /** Agent ids that have a warm mode. */
  warmable: () => string[];
}

export const warmApi: WarmApi = {
  status: () => tauri.standbyGetStatus(),
  setConfig: (config) => tauri.standbySetConfig(config),
  setProject: (path) => tauri.standbySetCurrentProject(path),
  warmable: () => preloadProviders(peekAgentRegistry().agents).filter((p) => p.supported).map((p) => p.id),
};

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A warm visible worker of `agent` is ready in `project`, and whether one is still starting there. */
export function warmState(status: StandbyStatus | null, project: string, agent: string): "ready" | "starting" | "none" {
  const mine = (status?.standbys ?? []).filter((s) => !s.headless && s.agent_type === agent && norm(s.project) === norm(project));
  return mine.some((s) => s.state === "ready") ? "ready" : mine.length > 0 ? "starting" : "none";
}

/**
 * Before the demo sends: when a warm worker is starting in the chosen folder, give it a few seconds
 * to finish. Resolves true when one is ready. Nothing starting (or no pool): false at once.
 */
export async function waitForWarm(api: WarmApi, project: string, agent: string, maxMs = 10_000, stepMs = 500): Promise<boolean> {
  const until = Date.now() + maxMs;
  for (;;) {
    const state = warmState(await api.status().catch(() => null), project, agent);
    if (state === "ready") return true;
    if (state === "none" || Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export type WarmResult = 'started' | 'kept' | 'nothing';

/**
 * Warm `agents` (those with a warm mode) in `project`. Never throws: warming is a convenience.
 * `kept`: Preload was already set up, so only the folder was passed on.
 */
export async function startWarming(api: WarmApi, agents: string[], project: string | null): Promise<WarmResult> {
  try {
    const status = await api.status();
    if (!status) return 'nothing';
    const configured = status.config.preload.enabled && Object.keys(status.config.preload.providers).length > 0;
    let result: WarmResult = 'kept';
    if (!configured) {
      const can = new Set(api.warmable());
      const wanted = agents.filter((id) => can.has(id));
      if (wanted.length === 0) return 'nothing';
      let config = withPreloadEnabled(status.config, true);
      for (const id of wanted) config = withPreloadCount(config, id, 1);
      await api.setConfig(config);
      result = 'started';
    }
    if (project) await api.setProject(project);
    return result;
  } catch {
    return 'nothing';
  }
}
