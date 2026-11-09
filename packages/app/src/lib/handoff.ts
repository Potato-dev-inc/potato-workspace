// "Handoff from here": the agent in a pane writes HANDOFF.md, then a NEW agent of the same kind opens in the same
// folder (same model when the pane is a chat that reports one) and is told to read it. The old pane stays open.
// Orchestration only: every call (send, wait, stat, start) comes in through `HandoffDeps`, so tests run it with
// fakes. Nothing here names an agent.
import { invoke } from '@tauri-apps/api/core';
import { chipValueName, configChips, isTerminalChatLane, startTerminalChat, tauriAcpChatApi, type AcpChatState } from './acpChat';
import { sendPaneMessage } from './paneOutbox';
import { startChatSession } from '../components/cockpit/newagent/start';

export const HANDOFF_FILE = 'HANDOFF.md';

/** Step 1: what the current agent is asked. One constant. */
export const HANDOFF_WRITE_PROMPT = `Please write a handoff for the next agent in a file named ${HANDOFF_FILE} in the root of this project folder. If ${HANDOFF_FILE} already exists, update it instead of starting over. Cover: the goal; what is done; what is left; the key files; decisions made and why; how to verify the work; gotchas. Keep it short and concrete. When the file is saved, reply with one line saying so, and do not start any other work.`;

/** Step 2: the first message of the new agent. */
export const HANDOFF_START_PROMPT = `Read ${HANDOFF_FILE} in this project folder and continue the work from there. Before you change anything, tell me the plan in a few lines and wait for my OK.`;

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

export interface HandoffDeps {
  /** The pane now, or undefined when it was closed. */
  pane: (paneId: string) => HandoffPane | undefined;
  /** The chat's state (chat panes only). */
  chatState: (paneId: string) => Promise<AcpChatState | null>;
  /** Queues a message for the pane. */
  send: (paneId: string, text: string) => Promise<unknown>;
  stat: (paneId: string) => Promise<HandoffFileStat>;
  /** Opens a new agent of the same kind in `cwd`, the same way the "+" menu does. Resolves to the pane id or null. */
  startTerminal: (agentType: string, cwd: string) => Promise<string | null>;
  startChat: (agentType: string, cwd: string) => Promise<string>;
  startTerminalChat: (agentType: string, cwd: string) => Promise<string>;
  /** Chat only: sets a setting (the model) on the new chat. */
  setConfig: (paneId: string, optionId: string, value: string) => Promise<unknown>;
  /** Opens a pane in the main area. */
  select: (paneId: string) => void;
  /** The new pane's title, once it has one. */
  titleOf: (paneId: string) => string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type HandoffStatus =
  | { kind: 'writing'; text: string }
  | { kind: 'opening'; text: string }
  | { kind: 'done'; text: string; newPaneId: string }
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
export async function runHandoff(paneId: string, deps: HandoffDeps, report: (s: HandoffStatus) => void): Promise<HandoffStatus> {
  const fail = (text: string): HandoffStatus => {
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

  report({ kind: 'writing', text: 'Writing handoff…' });
  let before: HandoffFileStat;
  try {
    before = await deps.stat(paneId);
  } catch (error) {
    return fail(`Could not look for ${HANDOFF_FILE}: ${errText(error)}`);
  }
  const model = pane.lane === 'acp' ? modelOf(await deps.chatState(paneId).catch(() => null)) : null;
  try {
    await deps.send(paneId, HANDOFF_WRITE_PROMPT);
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

  report({ kind: 'opening', text: 'Opening a new agent…' });
  let newId: string | null;
  try {
    if (pane.lane === 'acp') newId = await deps.startChat(pane.agentType, pane.cwd);
    else if (isTerminalChatLane(pane.lane)) newId = await deps.startTerminalChat(pane.agentType, pane.cwd);
    else newId = await deps.startTerminal(pane.agentType, pane.cwd);
  } catch (error) {
    return fail(`The handoff is written, but the new agent didn't start: ${errText(error)}`);
  }
  if (!newId) return fail("The handoff is written, but the new agent didn't start.");
  // A terminal start opens its own pane (`newAgent` selects it); chats are opened here.
  if (pane.lane === 'acp' || isTerminalChatLane(pane.lane)) deps.select(newId);

  const note = model ? await passModel(newId, model, deps) : '';
  try {
    await deps.send(newId, HANDOFF_START_PROMPT);
  } catch (error) {
    return fail(`The new agent opened, but its first message was not sent: ${errText(error)}`);
  }
  const done: HandoffStatus = { kind: 'done', newPaneId: newId, text: `Opened ${deps.titleOf(newId) ?? 'a new agent'}${note}` };
  report(done);
  return done;
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
    stat: (id) => invoke<HandoffFileStat>('handoff_file_stat', { paneId: id }),
    startTerminal: (agent, cwd) => cockpit.newAgent(agent, undefined, false, cwd),
    startChat: startChatSession,
    startTerminalChat: (agent, cwd) => startTerminalChat(agent, cwd),
    setConfig: (id, option, value) => tauriAcpChatApi.setConfig(id, option, value),
    select: cockpit.select,
    titleOf: cockpit.titleOf,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
