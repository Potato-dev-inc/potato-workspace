// Force yes, Fences and Pins: typed wrappers for the commands in `commands/agent_rules.rs`. Only the app's own window can
// call them (the phone and the agent tools have no route), so none of these can be loosened from outside.
import { invoke } from '@tauri-apps/api/core';
import { errorSentence } from './sayError';

/** Starting settings of new agents. A field left out or null is "not pinned". */
export interface Pin {
  model?: string | null;
  mode?: string | null;
  /** Start new agents with Force yes on. */
  force_yes?: boolean | null;
  notes?: string | null;
}

export interface ProjectRules {
  /** The project as the app keys it (lower case, forward slashes). */
  project: string;
  fences: string[];
  pin: Pin;
}

export interface RulesOverview {
  /** Agent ids that start their chats and panes with Force yes on. */
  forceYesAgents: string[];
  pinGlobal: Pin;
  projects: ProjectRules[];
}

/** What a new agent of one agent in one project starts with, after the project's pin is laid over the global one. */
export interface EffectivePins {
  model: string | null;
  mode: string | null;
  force_yes: boolean;
  force_yes_source: 'pin' | 'agent' | null;
  notes: string | null;
  fences: string[];
}

export interface AgentRulesApi {
  overview: () => Promise<RulesOverview>;
  effective: (agent: string, project: string | null) => Promise<EffectivePins>;
  setForceYesAgent: (agent: string, on: boolean) => Promise<boolean>;
  fenceAdd: (project: string, path: string) => Promise<string[]>;
  fenceRemove: (project: string, fence: string) => Promise<string[]>;
  pinSet: (project: string | null, pin: Pin) => Promise<Pin>;
  /** Force yes of one terminal pane (a chat's switch is `setForceYes` of the chat api). */
  paneSetForceYes: (paneId: string, on: boolean) => Promise<boolean>;
  paneForceYes: (paneId: string, agent: string, cwd: string) => Promise<boolean>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Desktop shell required: ${command}`);
  return invoke<T>(command, args);
}

export const tauriAgentRulesApi: AgentRulesApi = {
  overview: () => call<RulesOverview>('agent_rules_overview'),
  effective: (agent, project) => call<EffectivePins>('agent_rules_effective', { agent, project }),
  setForceYesAgent: (agent, on) => call<boolean>('agent_rules_set_force_yes_agent', { agent, on }),
  fenceAdd: (project, path) => call<string[]>('agent_rules_fence_add', { project, path }),
  fenceRemove: (project, fence) => call<string[]>('agent_rules_fence_remove', { project, fence }),
  pinSet: (project, pin) => call<Pin>('agent_rules_pin_set', { project, pin }),
  paneSetForceYes: (paneId, on) => call<boolean>('pane_set_force_yes', { paneId, on }),
  paneForceYes: (paneId, agent, cwd) => call<boolean>('pane_force_yes', { paneId, agent, cwd }),
};

export const EMPTY_OVERVIEW: RulesOverview = { forceYesAgents: [], pinGlobal: {}, projects: [] };
export const NO_PINS: EffectivePins = { model: null, mode: null, force_yes: false, force_yes_source: null, notes: null, fences: [] };

/** True when the project has nothing pinned: no model, mode, Force yes, notes or fences. */
export function nothingPinned(pins: EffectivePins | null): boolean {
  return !pins || (!pins.model && !pins.mode && !pins.force_yes && !pins.notes && pins.fences.length === 0);
}

/** A project path as the backend keys it, to find its entry in the overview. */
export function ruleKey(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.toLowerCase();
}

/** The rules entry of a project (case and slash style do not matter), or an empty one. */
export function rulesOf(overview: RulesOverview, project: string): ProjectRules {
  return overview.projects.find((p) => p.project === ruleKey(project)) ?? { project: ruleKey(project), fences: [], pin: {} };
}

/** The wire message of a failed command as one plain sentence (`CODE: sentence` -> `sentence`). */
export function ruleError(e: unknown): string {
  return errorSentence(e);
}
