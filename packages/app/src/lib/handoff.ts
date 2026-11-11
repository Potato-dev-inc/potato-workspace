// "Hand off": what the button does is a setting (Settings > Agents > "Hand off does"):
//   - Quick handoff ("file"): the agent writes HANDOFF.md (the task, and how this person works), the app adds the
//     person's fixed notes, and that is all. No new agent opens.
//   - Handoff to new agent ("new_agent", the default): the agent writes a temporary note under .potato/handoffs/, the
//     app adds the fixed notes, a NEW agent of the same kind (same model and sign-in where known) reads it and answers
//     only "Ready", and then the note moves to the app's data folder. The old pane stays open.
// Orchestration only: every call (send, wait, stat, start) comes in through `HandoffDeps`, so tests run it with
// fakes. Nothing here names an agent.
import { invoke } from '@tauri-apps/api/core';
import { chipValueName, configChips, isTerminalChatLane, startTerminalChat, tauriAcpChatApi, type AcpChatState } from './acpChat';
import { sendPaneMessage } from './paneOutbox';
import { startChatSession } from '../components/cockpit/newagent/start';

export const HANDOFF_FILE = 'HANDOFF.md';

/** Quick step 1: what the current agent is asked. `path` is the exact file to write. Two parts, then one reply line. */
const WRITE_PARTS = `Write two parts.

## Part 1: The task
The goal; what is done; what is left; the key files; decisions made and why; how to verify the work; gotchas. Keep it short and concrete.

## Part 2: How this person works
What you saw in THIS conversation about the person's working style. For example: whether they delegate to subagents or helper agents (which kinds and which models); whether they want a plan or approval before changes; their commit and push habits; their testing and verification habits; how they like updates (short or detailed, language and tone); the tools and workflows they rely on; and things they said never to do. Write only what you actually saw. Do not guess. If you saw nothing about a point, leave it out.

When the file is saved, reply with one line saying so, and do nothing else.`;

export const quickWritePrompt = (path: string): string =>
  `Please write a handoff for the next agent to this exact file: ${path}
Create the folder if it is missing. Use no other file name, and do not touch ${HANDOFF_FILE}. ${WRITE_PARTS}`;

/** Quick handoff: what the agent is asked. HANDOFF.md in the project root; an existing one is updated. */
export const fileWritePrompt = (): string =>
  `Please write a handoff for the next agent in a file named ${HANDOFF_FILE} in the root of this project folder. If ${HANDOFF_FILE} already exists, update it instead of starting over. ${WRITE_PARTS}`;

/** Quick step 3: the first message of the new agent. It reads the file, takes it in, and says only "Ready". */
export const quickStartPrompt = (path: string): string =>
  `Read this file now: ${path}
Take it in fully: the task and how this person works. Then reply with only the word "Ready". Do no other work and make no plan.`;

/** Shown when the new agent cannot be given the old one's model (terminal panes). */
export const MODEL_UNKNOWN_NOTE = 'Same agent; model not known for terminal panes';

/** How long we wait for the agent to start writing, and for the whole turn. */
export const HANDOFF_START_TIMEOUT_MS = 45_000;
export const HANDOFF_TURN_TIMEOUT_MS = 10 * 60_000;
export const HANDOFF_POLL_MS = 1000;

/** What the Rust `handoff_file_stat` answers (camelCase). */
export interface HandoffFileStat {
  exists: boolean;
  modifiedMs: number;
  bytes: number;
}

/** What we know of the pane being handed off. */
export interface HandoffPane {
  id: string;
  agentType: string;
  cwd: string;
  /** The raw `PaneInfo.lane`: `acp` (chat), `terminal_chat`, or absent (terminal). */
  lane?: string | null;
  /** The pane's status (`running`, `waiting_input`, `idle`, `error`). */
  status: string;
}

/** Is the agent working right now? `null`: the pane is gone. `waiting`: it stopped for the person. */
export type Busy = 'busy' | 'idle' | 'waiting' | null;

/** What the quick way needs on top of the ordinary calls. */
export interface QuickDeps {
  /** `YYYYMMDD-HHMM` of now, local time. */
  stamp: () => string;
  /** Makes the temporary folder, hides it from git, and picks the file. Resolves to the stamp used and the absolute path. */
  prepare: (paneId: string, stamp: string) => Promise<{ stamp: string; path: string }>;
  /** Adds the person's fixed notes to the written file (under "Always remember"): the temporary file with this stamp, or HANDOFF.md when there is no stamp. */
  appendNotes: (paneId: string, stamp: string | undefined, notes: string) => Promise<unknown>;
  /** Moves the file to the app's data folder. Resolves to where it is now. */
  archive: (paneId: string, stamp: string) => Promise<string>;
  /** The sign-in (account id) the pane runs under, when the app knows it. */
  account: (paneId: string) => Promise<string | null | undefined>;
}

/** What the Hand off button does. */
export type HandoffMode = 'file' | 'new_agent';
export const DEFAULT_HANDOFF_MODE: HandoffMode = 'new_agent';
/** The button's label follows the mode. */
export const handoffLabel = (mode: HandoffMode): string => (mode === 'file' ? 'Quick handoff' : 'Hand off to new agent');

/** The two settings, read when a handoff starts. */
export interface HandoffOptions {
  mode: HandoffMode;
  fixedNotes: string;
}
export const DEFAULT_OPTIONS: HandoffOptions = { mode: DEFAULT_HANDOFF_MODE, fixedNotes: '' };

export interface HandoffDeps {
  /** The pane now, or undefined when it was closed. */
  pane: (paneId: string) => HandoffPane | undefined;
  /** The chat's state (chat panes only). */
  chatState: (paneId: string) => Promise<AcpChatState | null>;
  /** Queues a message for the pane. */
  send: (paneId: string, text: string) => Promise<unknown>;
  /** Looks at HANDOFF.md, or (quick) at the temporary file with this stamp. */
  stat: (paneId: string, stamp?: string) => Promise<HandoffFileStat>;
  /** Opens a new agent of the same kind in `cwd`, the same way the "+" menu does. Resolves to the pane id or null. `accountId` is given only in the quick way. */
  startTerminal: (agentType: string, cwd: string, accountId?: string) => Promise<string | null>;
  startChat: (agentType: string, cwd: string, accountId?: string) => Promise<string>;
  startTerminalChat: (agentType: string, cwd: string, accountId?: string) => Promise<string>;
  /** Chat only: sets a setting (the model) on the new chat. */
  setConfig: (paneId: string, optionId: string, value: string) => Promise<unknown>;
  /** Opens a pane in the main area. */
  select: (paneId: string) => void;
  /** The new pane's title, once it has one. */
  titleOf: (paneId: string) => string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  quick: QuickDeps;
}

export type HandoffStatus =
  | { kind: 'writing'; text: string }
  | { kind: 'opening'; text: string }
  | { kind: 'done'; text: string; newPaneId: string }
  /** Quick handoff finished: HANDOFF.md is saved ("Open file" opens it). */
  | { kind: 'saved'; text: string; paneId: string }
  | { kind: 'failed'; text: string };

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.';

/** Is the agent working? Chat: the session says. Terminal: the pane status. */
export async function probeBusy(paneId: string, deps: Pick<HandoffDeps, 'pane' | 'chatState'>): Promise<Busy> {
  const pane = deps.pane(paneId);
  if (!pane) return null;
  if (pane.lane === 'acp') {
    const state = await deps.chatState(paneId).catch(() => null);
    if (!state || state.closed) return null;
    if (state.status === 'waiting_input' || state.permissions.length > 0) return 'waiting';
    return state.turnInFlight ? 'busy' : 'idle';
  }
  if (pane.status === 'error') return null;
  if (pane.status === 'waiting_input') return 'waiting';
  return pane.status === 'running' ? 'busy' : 'idle';
}

export type TurnEnd = 'done' | 'gone' | 'waiting' | 'never_started' | 'timeout';

/**
 * Waits for the turn that was just sent to start and then end. A turn that never shows as busy within
 * `HANDOFF_START_TIMEOUT_MS` is `never_started`; one still busy after `HANDOFF_TURN_TIMEOUT_MS` is `timeout`.
 */
export async function waitForTurnEnd(paneId: string, deps: Pick<HandoffDeps, 'pane' | 'chatState' | 'sleep' | 'now'>): Promise<TurnEnd> {
  const begun = deps.now();
  let sawBusy = false;
  for (;;) {
    const busy = await probeBusy(paneId, deps);
    if (busy === null) return 'gone';
    if (busy === 'waiting') return 'waiting';
    if (busy === 'busy') sawBusy = true;
    else if (sawBusy) return 'done';
    const waited = deps.now() - begun;
    if (!sawBusy && waited > HANDOFF_START_TIMEOUT_MS) return 'never_started';
    if (waited > HANDOFF_TURN_TIMEOUT_MS) return 'timeout';
    await deps.sleep(HANDOFF_POLL_MS);
  }
}

/** The model setting of a chat: its option id and current value, or null (terminal panes, or an agent that lists none). */
export function modelOf(state: AcpChatState | null): { optionId: string; value: string; name: string } | null {
  const chip = configChips(state).find((c) => c.category === 'model');
  return chip ? { optionId: chip.id, value: chip.value, name: chipValueName(chip) } : null;
}

const MODEL_TRIES = 20;

/** Give the new chat the old chat's model, once it lists its settings. Resolves to a note for the status line, or ''. */
async function passModel(newPaneId: string, model: { optionId: string; value: string; name: string }, deps: HandoffDeps): Promise<string> {
  const kept = ' (the new agent kept its default model)';
  for (let i = 0; i < MODEL_TRIES; i++) {
    const state = await deps.chatState(newPaneId).catch(() => null);
    const mine = configChips(state).find((c) => c.id === model.optionId);
    if (mine) {
      if (mine.value === model.value) return ` (${model.name})`;
      try {
        await deps.setConfig(newPaneId, model.optionId, model.value);
        return ` (${model.name})`;
      } catch {
        return kept;
      }
    }
    await deps.sleep(500);
  }
  return kept;
}

/**
 * Runs the whole handoff. Never throws: every outcome is a status. `report` is called with each step.
 * The old pane is never touched except for the one message and reading its state.
 */
export async function runHandoff(paneId: string, deps: HandoffDeps, report: (s: HandoffStatus) => void, options: HandoffOptions = DEFAULT_OPTIONS): Promise<HandoffStatus> {
  const fail: Fail = (text) => {
    const s: HandoffStatus = { kind: 'failed', text };
    report(s);
    return s;
  };
  const pane = deps.pane(paneId);
  if (!pane) return fail('This pane is not open any more.');
  if (!pane.cwd) return fail("This pane has no project folder, so there's nowhere to put HANDOFF.md.");
  const busyNow = await probeBusy(paneId, deps);
  if (busyNow === 'busy') return fail('The agent is still working. Wait for it to finish, then try again.');
  if (busyNow === 'waiting') return fail('The agent is waiting for you. Answer it first, then try again.');
  if (busyNow === null) return fail('This pane is not running any more.');
  if (options.mode === 'file') return runFile(paneId, pane, deps, report, fail, options.fixedNotes);
  return runNewAgent(paneId, pane, deps, report, fail, options.fixedNotes);
}

type Fail = (text: string) => HandoffStatus;

/** Quick handoff: the agent writes HANDOFF.md, the fixed notes are added, and that is all. */
async function runFile(paneId: string, pane: HandoffPane, deps: HandoffDeps, report: (s: HandoffStatus) => void, fail: Fail, fixedNotes: string): Promise<HandoffStatus> {
  void pane;
  report({ kind: 'writing', text: 'Writing handoff…' });
  let before: HandoffFileStat;
  try {
    before = await deps.stat(paneId);
  } catch (error) {
    return fail(`Could not look for ${HANDOFF_FILE}: ${errText(error)}`);
  }
  try {
    await deps.send(paneId, fileWritePrompt());
  } catch (error) {
    return fail(`Could not ask the agent to write the handoff: ${errText(error)}`);
  }
  const end = await waitForTurnEnd(paneId, deps);
  if (end === 'gone') return fail('The pane was closed before the handoff was written.');
  if (end === 'waiting') return fail('The agent stopped to ask you something. Answer it, then try again.');
  if (end === 'never_started') return fail("The agent didn't start on the handoff. Try again when it is ready.");
  if (end === 'timeout') return fail('The agent took too long to write the handoff.');

  let after: HandoffFileStat;
  try {
    after = await deps.stat(paneId);
  } catch (error) {
    return fail(`Could not look for ${HANDOFF_FILE}: ${errText(error)}`);
  }
  if (!after.exists) return fail(`The agent finished but ${HANDOFF_FILE} wasn't written.`);
  if (before.exists && after.modifiedMs === before.modifiedMs && after.bytes === before.bytes) {
    return fail(`The agent finished but ${HANDOFF_FILE} wasn't updated.`);
  }
  if (fixedNotes.trim()) {
    try {
      await deps.quick.appendNotes(paneId, undefined, fixedNotes);
    } catch (error) {
      return fail(`${HANDOFF_FILE} is written, but your fixed notes could not be added: ${errText(error)}`);
    }
  }
  const saved: HandoffStatus = { kind: 'saved', paneId, text: `${HANDOFF_FILE} saved` };
  report(saved);
  return saved;
}

/** "Open file" on the saved status: opens HANDOFF.md of the pane's folder. */
export function openHandoffFile(paneId: string): Promise<unknown> {
  return invoke('handoff_open_file', { paneId });
}

/** Handoff to new agent: a temporary note, the same agent, "Ready", then tidy up. */
async function runNewAgent(paneId: string, pane: HandoffPane, deps: HandoffDeps, report: (s: HandoffStatus) => void, fail: Fail, fixedNotes: string): Promise<HandoffStatus> {
  report({ kind: 'writing', text: 'Writing handoff…' });
  let prepared: { stamp: string; path: string };
  try {
    prepared = await deps.quick.prepare(paneId, deps.quick.stamp());
  } catch (error) {
    return fail(`Could not get the handoff file ready: ${errText(error)}`);
  }
  const { stamp, path } = prepared;
  let before: HandoffFileStat;
  try {
    before = await deps.stat(paneId, stamp);
  } catch (error) {
    return fail(`Could not look for the handoff file: ${errText(error)}`);
  }
  const model = pane.lane === 'acp' ? modelOf(await deps.chatState(paneId).catch(() => null)) : null;
  const account = (await deps.quick.account(paneId).catch(() => null)) || undefined;
  try {
    await deps.send(paneId, quickWritePrompt(path));
  } catch (error) {
    return fail(`Could not ask the agent to write the handoff: ${errText(error)}`);
  }

  const end = await waitForTurnEnd(paneId, deps);
  if (end === 'gone') return fail('The pane was closed before the handoff was written.');
  if (end === 'waiting') return fail('The agent stopped to ask you something. Answer it, then try again.');
  if (end === 'never_started') return fail("The agent didn't start on the handoff. Try again when it is ready.");
  if (end === 'timeout') return fail('The agent took too long to write the handoff.');

  let after: HandoffFileStat;
  try {
    after = await deps.stat(paneId, stamp);
  } catch (error) {
    return fail(`Could not look for the handoff file: ${errText(error)}`);
  }
  if (!after.exists || after.bytes === 0) return fail(`The agent finished but the handoff file wasn't written. It should be at ${path}`);
  if (before.exists && after.modifiedMs === before.modifiedMs && after.bytes === before.bytes) {
    return fail(`The agent finished but the handoff file wasn't updated: ${path}`);
  }

  // The fixed notes go in on this side, after the file is written, so the agent never has to remember them.
  if (fixedNotes.trim()) {
    try {
      await deps.quick.appendNotes(paneId, stamp, fixedNotes);
    } catch (error) {
      return fail(`The handoff is written, but your fixed notes could not be added (${errText(error)}). The file is at ${path}`);
    }
  }

  report({ kind: 'opening', text: 'Opening a new agent…' });
  const withAccount: [string] | [] = account ? [account] : [];
  let newId: string | null;
  try {
    if (pane.lane === 'acp') newId = await deps.startChat(pane.agentType, pane.cwd, ...withAccount);
    else if (isTerminalChatLane(pane.lane)) newId = await deps.startTerminalChat(pane.agentType, pane.cwd, ...withAccount);
    else newId = await deps.startTerminal(pane.agentType, pane.cwd, ...withAccount);
  } catch (error) {
    return fail(`The handoff is written, but the new agent didn't start: ${errText(error)}. The file is at ${path}`);
  }
  if (!newId) return fail(`The handoff is written, but the new agent didn't start. The file is at ${path}`);
  if (pane.lane === 'acp' || isTerminalChatLane(pane.lane)) deps.select(newId);

  const note = model ? await passModel(newId, model, deps) : `. ${MODEL_UNKNOWN_NOTE}`;
  try {
    await deps.send(newId, quickStartPrompt(path));
  } catch (error) {
    return fail(`The new agent opened, but its first message was not sent: ${errText(error)}. The file is at ${path}`);
  }

  // Wait for its one-word reply, then take the file out of the project.
  report({ kind: 'opening', text: 'Waiting for the new agent to get ready…' });
  const opened = `Opened ${deps.titleOf(newId) ?? 'a new agent'}${note}`;
  const replied = await waitForTurnEnd(newId, deps);
  const finish = (text: string): HandoffStatus => {
    const done: HandoffStatus = { kind: 'done', newPaneId: newId, text };
    report(done);
    return done;
  };
  if (replied !== 'done') return finish(`${opened}. It did not finish reading, so the handoff file stays at ${path}`);
  try {
    await deps.quick.archive(paneId, stamp);
  } catch (error) {
    return finish(`${opened}. The handoff file could not be moved (${errText(error)}). It is at ${path}`);
  }
  return finish(opened);
}

/** The real calls. `cockpit` supplies what only the window knows. */
export function realHandoffDeps(cockpit: {
  pane: HandoffDeps['pane'];
  newAgent: (agentId: string, accountId?: string, isolated?: boolean, projectPath?: string) => Promise<string | null>;
  select: (paneId: string) => void;
  titleOf: HandoffDeps['titleOf'];
}): HandoffDeps {
  return {
    pane: cockpit.pane,
    chatState: (id) => tauriAcpChatApi.state(id),
    send: sendPaneMessage,
    stat: (id, stamp) => invoke<HandoffFileStat>('handoff_file_stat', stamp ? { paneId: id, stamp } : { paneId: id }),
    startTerminal: (agent, cwd, accountId) => cockpit.newAgent(agent, accountId, false, cwd),
    startChat: (agent, cwd, accountId) => startChatSession(agent, cwd, accountId),
    startTerminalChat: (agent, cwd, accountId) => startTerminalChat(agent, cwd, accountId),
    setConfig: (id, option, value) => tauriAcpChatApi.setConfig(id, option, value),
    select: cockpit.select,
    titleOf: cockpit.titleOf,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    quick: {
      stamp: () => handoffStamp(new Date()),
      prepare: (id, stamp) => invoke<{ stamp: string; path: string }>('handoff_quick_prepare', { paneId: id, stamp }),
      appendNotes: (id, stamp, notes) => invoke('handoff_quick_append', { paneId: id, stamp: stamp ?? null, notes }),
      archive: (id, stamp) => invoke<string>('handoff_quick_archive', { paneId: id, stamp }),
      account: (id) => invoke<string | null>('handoff_pane_account', { paneId: id }),
    },
  };
}

/** `YYYYMMDD-HHMM` in local time: the temporary file's name is `handoff-<this>.md`. */
export function handoffStamp(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`;
}
