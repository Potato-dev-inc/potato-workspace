// Sends what the New agent page asks for: starts the agent the same way the "+" menu does (a terminal pane through
// `newAgent`) or as a chat session (`acp_chat_start`, the Labs way), then queues the person's first message in the
// pane's outbox, which types it once the agent is ready. Nothing here names an agent.
import { invoke } from '@tauri-apps/api/core';
import { blockOf, type ChatBlock } from '../../../lib/acpAddon';
import { configChips, tauriAcpChatApi, type AcpChatApi } from '../../../lib/acpChat';
import { sendPaneMessage } from '../../../lib/paneOutbox';
import type { StartRequest } from './model';

export interface StartDeps {
  /** The cockpit's `newAgent`: opens the pane and the starting view; resolves to the pane id, or null if it failed. */
  newAgent: (agentId: string, accountId?: string, isolated?: boolean, projectPath?: string, model?: string) => Promise<string | null>;
  /** Starts a chat session in `folder`; resolves to its pane id. Rejects with one plain sentence. */
  startChat: (agentId: string, folder: string, accountId?: string) => Promise<string>;
  /**
   * Puts a chat on `model` once it lists its settings, before the first message. Resolves to null when it is set, or to
   * one plain sentence when it could not be (the chat then keeps its default). Absent: the model is not applied.
   */
  setChatModel?: (paneId: string, model: string) => Promise<string | null>;
  /** Opens a pane in the main area. */
  select: (paneId: string) => void;
  /** Queues a message for the pane. */
  send: (paneId: string, text: string) => Promise<unknown>;
  notify: (text: string) => void;
}

/** A chat start that stopped for a reason the page answers with a card: the add-on is missing, or a sign-in is needed. */
export interface StartBlock {
  blocked: ChatBlock;
  agentId: string;
  message: string;
}

export const isStartBlock = (value: unknown): value is StartBlock =>
  !!value && typeof value === 'object' && ((value as StartBlock).blocked === 'addon' || (value as StartBlock).blocked === 'signin');

const errText = (error: unknown): string => (error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.');

/** The real chat start. */
export async function startChatSession(agentId: string, folder: string, accountId?: string): Promise<string> {
  const started = await invoke<{ pane_id: string }>('acp_chat_start', accountId ? { agentId, folder, explicit: true, accountId } : { agentId, folder, explicit: true });
  return started.pane_id;
}

const MODEL_TRIES = 20;
const MODEL_WAIT_MS = 500;

/** The choice of a model chip that `model` names: by id, or by the name the agent shows (any case). */
export function chipChoiceFor(model: string, choices: readonly { value: string; name: string }[]): string | null {
  const want = model.trim().toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === want)?.value ?? choices.find((c) => c.name.toLowerCase() === want)?.value ?? null;
}

/** The real chat model step: waits (bounded) for the session's model setting, then sets it with `session/set_config_option`. */
export async function setChatModelOn(paneId: string, model: string, api: Pick<AcpChatApi, 'state' | 'setConfig'> = tauriAcpChatApi, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | null> {
  const kept = `${model} was not set; the chat uses its default model.`;
  for (let i = 0; i < MODEL_TRIES; i++) {
    const state = await api.state(paneId).catch(() => null);
    const chip = configChips(state).find((c) => c.category === 'model');
    if (chip) {
      const value = chipChoiceFor(model, chip.choices);
      if (value === null) return `This chat does not list "${model}", so it uses its default model.`;
      if (value === chip.value) return null;
      try {
        await api.setConfig(paneId, chip.id, value);
        return null;
      } catch {
        return kept;
      }
    }
    await sleep(MODEL_WAIT_MS);
  }
  return kept;
}

export const realStartDeps = (
  cockpit: Pick<StartDeps, 'newAgent' | 'select' | 'notify'>,
): StartDeps => ({ ...cockpit, startChat: startChatSession, setChatModel: (paneId, model) => setChatModelOn(paneId, model), send: sendPaneMessage });

/**
 * Runs one request. Resolves to the pane id, or null when nothing started (the person was told why). A chat that cannot
 * start for want of its add-on or a sign-in resolves to a `StartBlock` instead, and nothing is announced: the page shows
 * the card. Never throws.
 */
export async function runStart(req: StartRequest, deps: StartDeps): Promise<string | StartBlock | null> {
  let paneId: string | null = null;
  const model = req.model?.trim() || undefined;
  try {
    if (req.runAs === 'chat') {
      if (!req.folder) {
        deps.notify('Pick a folder for a chat session.');
        return null;
      }
      paneId = await (req.accountId === undefined ? deps.startChat(req.agentId, req.folder) : deps.startChat(req.agentId, req.folder, req.accountId));
      deps.select(paneId);
      // The model goes in before the first message: ACP changes settings between turns.
      if (model && deps.setChatModel) {
        const problem = await deps.setChatModel(paneId, model).catch(() => `${model} was not set; the chat uses its default model.`);
        if (problem) deps.notify(problem);
      }
    } else {
      paneId = await (model ? deps.newAgent(req.agentId, req.accountId, req.isolated, req.folder, model) : deps.newAgent(req.agentId, req.accountId, req.isolated, req.folder));
    }
  } catch (error) {
    const message = errText(error);
    const blocked = req.runAs === 'chat' ? blockOf(message) : null;
    if (blocked) return { blocked, agentId: req.agentId, message };
    deps.notify(message);
    return null;
  }
  if (!paneId) return null; // the starting view shows why
  try {
    await deps.send(paneId, req.prompt);
  } catch (error) {
    deps.notify(`The agent started, but your message was not sent: ${errText(error)}`);
  }
  return paneId;
}
