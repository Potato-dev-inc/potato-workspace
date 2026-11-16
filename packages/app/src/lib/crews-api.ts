// Typed wrappers for the crew commands (`commands/crews.rs`): a crew is a saved team of agents.
// "Save this team" reads a draft from a live pane; "Start crew" starts a saved one in a folder.
// The crew shape is shared with the command line (`@potato-workspace/shared`, crews.ts).
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { Crew, CrewApplied, CrewOpened, CrewPermissions, CrewProblem, CrewRole, CrewRoutePreview, CrewSummary } from '@potato-workspace/shared';

export type { Crew, CrewApplied, CrewOpened, CrewPermissions, CrewProblem, CrewRole, CrewRoutePreview, CrewSummary };

/** The agent a starter role has until the crew starts: the person's default agent. */
export const DEFAULT_AGENT = '{default}';

export interface CrewAgent {
  id: string;
  label: string;
}

export interface CrewAgents {
  /** Agents that can take a role here (installed and able to take a task). */
  agents: CrewAgent[];
  /** The agent `{default}` stands for; null when none is set up. */
  default: string | null;
}

export interface CrewDraft {
  crew: Crew;
  /** Helpers left out because a crew holds at most 8 roles. */
  omitted: number;
}

export interface CrewSaveOutcome {
  slug: string | null;
  errors: CrewProblem[];
}

export interface CrewStartOutcome {
  started: { role: string; agent_type: string; pane_id: string }[];
  failed: { role: string; code: string; message: string } | null;
  /** Roles not tried because an earlier one failed. */
  not_started: string[];
}

/** One step of a followed task: the role, who handed it over, the exact words and what came back. */
export interface CrewFollowStep {
  role: string;
  from: string | null;
  words: string;
  at_ms: number;
  status: string;
  came_back: string | null;
}

export interface CrewFollowTask {
  id: string;
  /** The person's words to the lead; empty when work was handed over without a recorded task. */
  words: string;
  at_ms: number;
  status: 'running' | 'done' | 'failed';
  steps: CrewFollowStep[];
}

/** What a shared crew file would set up. Reading it changes nothing. */
export interface CrewShareCheck {
  crew: Crew;
  routing_text: string;
  problems: CrewProblem[];
  may_merge: string[];
  may_start_helpers: string[];
  runs_commands: string[];
  standbys: number;
}

export interface CrewsApi {
  /** The crews the person saved. */
  list: () => Promise<CrewSummary[]>;
  /** The built-in starter crews. They are never saved unless copied. */
  starters: () => Promise<CrewSummary[]>;
  /** A saved crew or a starter, by slug. */
  get: (slug: string) => Promise<Crew>;
  agents: () => Promise<CrewAgents>;
  draft: (paneId: string) => Promise<CrewDraft>;
  /** `replace` overwrites the saved crew with the same name (the sheet asks first). */
  save: (crew: Crew, replace?: boolean) => Promise<CrewSaveOutcome>;
  remove: (slug: string) => Promise<void>;
  /** `agents` maps role names to the agent the Start sheet chose for them. */
  start: (slug: string, folder: string, agents?: Record<string, string>) => Promise<CrewStartOutcome>;
  /** The ready-made crews (read-only). */
  templates: () => Promise<CrewSummary[]>;
  /** A saved crew or a template with its rules and problems, for the canvas. */
  open: (slug: string) => Promise<CrewOpened>;
  /** Every problem of a crew as it is now. Nothing is saved. */
  check: (crew: Crew) => Promise<CrewProblem[]>;
  /** Save a crew with its routing rules. */
  saveCanvas: (crew: Crew, routingText: string, replace?: boolean) => Promise<CrewSaveOutcome>;
  /** "Try a task": a dry run. Null when the rules name no role of the crew. */
  tryTask: (crew: Crew, routingText: string, task: string) => Promise<CrewRoutePreview | null>;
  /** Keep the crew's standby helpers ready in a folder. */
  apply: (crew: Crew, folder: string, raiseLimit?: boolean) => Promise<CrewApplied>;
  /** The tasks given to the lead of this crew and the hand-overs of each, newest first. Read only. */
  follow: (crew: Crew) => Promise<CrewFollowTask[]>;
  /** Share: asks where to save one file with the crew and its rules. The path, or null when cancelled. */
  exportFile: (crew: Crew, routingText: string) => Promise<string | null>;
  /** Open a shared crew: asks for a file and describes it. Nothing is saved or run. Null when cancelled. */
  importFile: () => Promise<CrewShareCheck | null>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Desktop shell required: ${command}`);
  return invoke<T>(command, args);
}

export const crewsApi: CrewsApi = {
  list: () => call<CrewSummary[]>('crews_list'),
  starters: () => call<CrewSummary[]>('crews_starters'),
  get: (slug) => call<Crew>('crews_get', { slug }),
  agents: () => call<CrewAgents>('crews_agents'),
  draft: (paneId) => call<CrewDraft>('crews_draft', { paneId }),
  save: (crew, replace = false) => call<CrewSaveOutcome>('crews_save', { crew, replace }),
  remove: (slug) => call<void>('crews_remove', { slug }),
  start: (slug, folder, agents) => call<CrewStartOutcome>('crews_start', { slug, folder, agents }),
  templates: () => call<CrewSummary[]>('crews_templates'),
  open: (slug) => call<CrewOpened>('crews_open', { slug }),
  check: (crew) => call<CrewProblem[]>('crews_check', { crew }),
  saveCanvas: (crew, routingText, replace = false) => call<CrewSaveOutcome>('crews_save_canvas', { crew, routingText, replace }),
  tryTask: (crew, routingText, task) => call<CrewRoutePreview | null>('crews_try_task', { crew, routingText, task }),
  apply: (crew, folder, raiseLimit = false) => call<CrewApplied>('crews_apply', { crew, folder, raiseLimit }),
  follow: (crew) => call<CrewFollowTask[]>('crews_follow', { crew }),
  exportFile: async (crew, routingText) => {
    if (!isTauri()) throw new Error('Desktop shell required: crews_export_file');
    const target = await saveDialog({ defaultPath: `${crew.name.trim() || 'crew'}.crew.json`, filters: [{ name: 'Potato crew', extensions: ['json'] }] });
    if (!target) return null;
    return invoke<string>('crews_export_file', { crew, routingText, target });
  },
  importFile: async () => {
    if (!isTauri()) throw new Error('Desktop shell required: crews_import_read');
    const source = await openDialog({ multiple: false, filters: [{ name: 'Potato crew', extensions: ['json'] }] });
    if (!source || Array.isArray(source)) return null;
    return invoke<CrewShareCheck>('crews_import_read', { source });
  },
};

/** A command error is `CODE: message`; the message is the part to show. */
export function crewErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^[A-Z][A-Z_]+: /, '');
}
