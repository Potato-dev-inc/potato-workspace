// The one-box "Add an agent" flow: the shapes the backend sends (SPEC-ADD-AGENT-1113 sections 1.1, 2.2), the thin
// invoke/listen wrapper, and the plain words for every step, chip and error. Nothing here names an agent.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type Tri = 'yes' | 'no' | 'unknown';
export type CapSource = 'definition' | 'handshake' | 'check' | 'seen' | 'unknown';
export type Level = 'l0' | 'l1' | 'l2' | 'l3' | 'l5';
export interface Cap {
  value: Tri;
  source: CapSource;
  proof: string;
  at: string | null;
}
export interface AgentCaps {
  schema: number;
  agent_id: string;
  label: string;
  level: Level;
  level_proof: Cap;
  program_version: string | null;
  chat: Cap;
  resume: Cap;
  shows_steps: Cap;
  edits_files: Cap;
  asks_before_edit: Cap;
  asks_before_shell: Cap;
  model_pick: Cap;
  models: string[];
  models_total: number;
  stop: Cap;
  images: Cap;
  usage: Cap;
  read_only: Cap;
}
export type StepId = 'find' | 'version' | 'chat_way' | 'handshake' | 'models' | 'save' | 'install';
export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export interface AddAgentStep {
  id: StepId;
  state: StepState;
  started_ms: number | null;
  elapsed_ms: number | null;
  limit_ms: number;
  detail: string | null;
}
export type AddAgentAction = 'retry' | 'open_agent' | 'show_install' | 'restart_app' | 'use_terminal' | 'open_labs' | 'none';
export interface AddAgentRun {
  run_id: string;
  input: string;
  agent_id: string | null;
  label: string | null;
  state: 'checking' | 'needs_install' | 'done' | 'failed' | 'cancelled';
  started_ms: number;
  steps: AddAgentStep[];
  install: { kind: 'program' | 'chat_addon'; label: string; what_will_run: string[]; source_host: string; can_install: boolean } | null;
  result: { agent_id: string; label: string; mode: 'chat' | 'terminal'; caps: AgentCaps; sign_in_needed: boolean; already_added: boolean } | null;
  error: { code: string; message: string; action: AddAgentAction; step: StepId | null } | null;
}

/** One agent already on this computer, as `agents_detect_installed` lists it. */
export interface FoundAgent {
  id: string;
  displayName: string;
  path: string;
  kind: string;
  version?: string | null;
}

export interface AddAgentApi {
  /** Agents found on this computer. Optional: a missing or failing call just hides "Found on this computer". */
  detectInstalled?(projectDir?: string): Promise<FoundAgent[]>;
  start(input: string, terminalOnly?: boolean): Promise<AddAgentRun>;
  status(runId: string): Promise<AddAgentRun>;
  cancel(runId: string): Promise<AddAgentRun>;
  approveInstall(runId: string): Promise<AddAgentRun>;
  /** Every step change arrives as the whole run. Resolves to the stop function. */
  onProgress(cb: (run: AddAgentRun) => void): Promise<() => void>;
}

const noop = () => undefined;

/** The real calls. Tauri arguments are camelCase on this side. */
export const addAgentApi: AddAgentApi = {
  detectInstalled: (projectDir) => invoke<FoundAgent[]>('agents_detect_installed', projectDir ? { projectDir } : {}),
  start: (input, terminalOnly) => invoke<AddAgentRun>('add_agent_start', { input, terminalOnly: terminalOnly === true ? true : null }),
  status: (runId) => invoke<AddAgentRun>('add_agent_status', { runId }),
  cancel: (runId) => invoke<AddAgentRun>('add_agent_cancel', { runId }),
  approveInstall: (runId) => invoke<AddAgentRun>('add_agent_approve_install', { runId }),
  onProgress: async (cb) => {
    try {
      const stop: UnlistenFn = await listen<AddAgentRun>('add-agent://progress', (e) => cb(e.payload));
      return stop;
    } catch {
      return noop; // a plain browser has no events
    }
  },
};

// ---- the capability invariants (SPEC 1.2, items 1 to 3), ported ----------------------------------------------------

/** Problems in `caps`, empty when it is fine. A mock or a reply that breaks these must not be drawn. */
export function checkCaps(caps: AgentCaps): string[] {
  const out: string[] = [];
  const all: Array<[string, Cap]> = [
    ['level_proof', caps.level_proof],
    ['chat', caps.chat],
    ['resume', caps.resume],
    ['shows_steps', caps.shows_steps],
    ['edits_files', caps.edits_files],
    ['asks_before_edit', caps.asks_before_edit],
    ['asks_before_shell', caps.asks_before_shell],
    ['model_pick', caps.model_pick],
    ['stop', caps.stop],
    ['images', caps.images],
    ['usage', caps.usage],
    ['read_only', caps.read_only],
  ];
  for (const [name, cap] of all) {
    if (cap.value !== 'unknown') {
      if (cap.source === 'unknown') out.push(`${name}: a value needs a source`);
      if (cap.proof.trim() === '') out.push(`${name}: a value needs a proof`);
      if (cap.at === null) out.push(`${name}: a value needs a time`);
    }
    if (cap.source === 'unknown' && cap.value !== 'unknown') out.push(`${name}: no source means unknown`);
  }
  if (caps.model_pick.value === 'yes' && caps.models.length === 0) out.push('model_pick: yes needs models');
  if (caps.chat.value === 'no' && caps.level !== 'l5') out.push('chat: no needs level l5');
  return out;
}

// ---- chips ----------------------------------------------------------------------------------------------------------

export type ChipKey = 'chat' | 'resume' | 'shows_steps' | 'edits_files' | 'asks_before_edit' | 'asks_before_shell' | 'model_pick' | 'stop' | 'images' | 'usage';

/** The chips, in the order the person sees them. */
export const CHIPS: ReadonlyArray<{ key: ChipKey; label: string }> = [
  { key: 'chat', label: 'Can chat' },
  { key: 'resume', label: 'Remembers the chat' },
  { key: 'shows_steps', label: 'Shows its steps' },
  { key: 'edits_files', label: 'Can change files' },
  { key: 'asks_before_edit', label: 'Asks before changing files' },
  { key: 'asks_before_shell', label: 'Asks before running commands' },
  { key: 'model_pick', label: 'Can pick a model' },
  { key: 'stop', label: 'Can stop' },
  { key: 'images', label: 'Can read pictures' },
  { key: 'usage', label: 'Shows usage' },
];

/** The mark is a pure function of the value. It is never upgraded. Unknown has no mark: its dashed outline and the caption say it. */
export function chipMark(value: Tri): string {
  return value === 'yes' ? '✓' : value === 'no' ? '✕' : '';
}

/** The caption above the chips that are not known yet. */
export const UNKNOWN_CAPTION = 'Fills in after your first chat:';

/** Where a chip's answer came from, for hover and focus. */
export function sourceText(source: CapSource, name: string): string {
  switch (source) {
    case 'definition':
      return "From Potato's tested setup";
    case 'handshake':
      return `${name} said so`;
    case 'check':
      return 'Checked on this computer';
    case 'seen':
      return 'Seen in a real chat';
    default:
      return 'Fills in after your first chat';
  }
}

// ---- steps ----------------------------------------------------------------------------------------------------------

/** The plain line for one step, or null when the line is hidden. Never uses the step's detail. */
export function stepLine(step: AddAgentStep, name: string, caps: AgentCaps | null): string | null {
  const { id, state } = step;
  const done = state === 'done';
  const skipped = state === 'skipped';
  switch (id) {
    case 'find':
      return done ? `Found ${name} on this computer` : `Looking for ${name} on this computer`;
    case 'version':
      if (skipped) return 'Version not shown';
      if (done) {
        // The number is the finished result's, or what the step reported (only a plain version number is shown).
        const detail = step.detail && /^[0-9][0-9A-Za-z.+-]{0,23}$/.test(step.detail.trim()) ? step.detail.trim() : null;
        const v = caps?.program_version || detail;
        return v ? `Version ${v}` : 'Version not shown';
      }
      return 'Reading its version';
    case 'chat_way':
      if (skipped) return 'It works in a terminal only';
      return done ? 'It can chat' : 'Checking if it can chat';
    case 'handshake':
      if (skipped) return null;
      return done ? `${name} answered` : `Saying hello to ${name}`;
    case 'models':
      if (skipped) return 'No model list';
      if (done) return caps && caps.models_total > 0 ? `${caps.models_total} models found` : 'Model list found';
      return 'Reading its model list';
    case 'save':
      return done ? 'Added' : `Adding ${name} to Potato`;
    case 'install':
      if (skipped || state === 'pending') return null;
      return done ? 'Installed' : `Installing ${name}`;
    default:
      return null;
  }
}

/** The "terminal only" chat_way step reads as skipped-in-words even when the backend marks it done. */
export const SLOW_NOTE = 'Some agents start slowly. This is normal.';
export const SLOW_AFTER_MS = 15_000;

// ---- errors (SPEC 2.4) ----------------------------------------------------------------------------------------------

export const ERROR_ACTIONS: Record<string, { action: AddAgentAction; button: string }> = {
  retry: { action: 'retry', button: 'Try again' },
  open_agent: { action: 'open_agent', button: 'Open {Name}' },
  show_install: { action: 'show_install', button: 'Show the install window' },
  restart_app: { action: 'restart_app', button: 'Restart Potato' },
  use_terminal: { action: 'use_terminal', button: 'Use it in a terminal instead' },
  open_labs: { action: 'open_labs', button: 'Open Labs' },
};

/** The button text for an error action, or null when there is no button. */
export function actionButton(action: AddAgentAction, name: string): string | null {
  const row = ERROR_ACTIONS[action];
  return row ? row.button.replace('{Name}', name) : null;
}

/** Final copy of every error, `{Name}` filled in. Used by the mocks; the backend sends the same words. */
export const ERROR_COPY: Record<string, { message: string; action: AddAgentAction }> = {
  ADD_BAD_INPUT: { message: 'Type one agent name, like kimi.', action: 'retry' },
  ADD_UNKNOWN_NAME: { message: 'Potato could not find {Name} on this computer.', action: 'retry' },
  ADD_ALREADY_ADDED: { message: '{Name} is already added.', action: 'open_agent' },
  ADD_INSTALL_FAILED: { message: '{Name} did not finish installing.', action: 'show_install' },
  ADD_NOT_SEEN_AFTER_INSTALL: { message: '{Name} is installed, but Potato cannot see it yet.', action: 'restart_app' },
  ADD_HANDSHAKE_SILENT: { message: '{Name} did not answer in time.', action: 'use_terminal' },
  ADD_HANDSHAKE_BAD: { message: '{Name} answered in a way Potato does not understand.', action: 'use_terminal' },
  ADD_CHAT_OFF: { message: 'Chat is turned off in Labs.', action: 'open_labs' },
  ADD_SAVE_FAILED: { message: 'Potato could not save {Name}. Nothing was changed.', action: 'retry' },
  ADD_BUSY: { message: 'Potato is already adding an agent.', action: 'none' },
  ADD_RUN_NOT_FOUND: { message: 'That check is gone. Start again.', action: 'retry' },
};

/** A message from the backend, or one sentence when the reply is empty. */
export const FALLBACK_ERROR = 'Potato could not add this agent.';

/** The name a screen shows: the label, else what was typed. */
export function nameOf(run: Pick<AddAgentRun, 'label' | 'input'>): string {
  return run.label && run.label.trim() !== '' ? run.label : run.input.trim();
}
