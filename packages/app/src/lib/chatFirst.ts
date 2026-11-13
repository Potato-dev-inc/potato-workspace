// Chat first: while "Show terminals" is off, every place that starts an agent starts it as a chat (ACP), and an agent that
// can only run in a terminal is not offered. This file holds the rules that need no screen: which agents can chat, which
// are left out, and the one start path the cockpit's `newAgent` takes (palette, board, inbox, companion, tray...).
// Nothing here names an agent: "can chat" is what the backend's lane view says.
import { t } from '../i18n';
import { errorCode } from './sayError';
import { startFailure, tauriAcpChatApi, type AcpChatApi, type AcpLaneView } from './acpChat';
import { setChatModelOn, startChatSession } from '../components/cockpit/newagent/start';

/** The ids (lower case) of the agents a chat can start for now: the backend lists a chat for them and it is not switched off. */
export function chatAgentIds(view: AcpLaneView | null | undefined): Set<string> {
  if (!view || !view.labs_enabled) return new Set();
  return new Set(view.agents.filter((a) => !a.disabled).map((a) => a.id.toLowerCase()));
}

/** Whether a chat can start for this agent. An unknown view says no (the caller decides what unknown means). */
export function canChat(view: AcpLaneView | null | undefined, agentId: string): boolean {
  return chatAgentIds(view).has(agentId.toLowerCase());
}

/**
 * Splits a list of agents into the ones to offer and how many were left out because they only run in a terminal.
 * A shell is a terminal by nature and is always left out (not counted: it is not an agent). Without a lane view (not read
 * yet, or Chat is off) nothing is hidden: the list is shown as it is.
 */
export function offeredAgents<T extends { type: string; shell?: boolean; disabled?: boolean }>(entries: readonly T[], view: AcpLaneView | null | undefined): { offered: T[]; needTerminals: number } {
  return splitByChat(entries, !view || !view.labs_enabled ? null : chatAgentIds(view));
}

/** `offeredAgents` over a set of ids that can chat (null: not known, nothing is hidden but the shells). */
export function splitByChat<T extends { type: string; shell?: boolean; disabled?: boolean }>(entries: readonly T[], ids: ReadonlySet<string> | null): { offered: T[]; needTerminals: number } {
  const agents = entries.filter((e) => !e.shell);
  if (!ids) return { offered: [...agents], needTerminals: 0 };
  const offered = agents.filter((e) => ids.has(e.type.toLowerCase()));
  // An agent that cannot open a pane at all (headless only) is not one that "needs a terminal".
  return { offered, needTerminals: agents.filter((e) => !e.disabled && !ids.has(e.type.toLowerCase())).length };
}

export interface ChatFirstRequest {
  agentId: string;
  accountId?: string;
  /** The project folder; absent: the app's default folder (the backend picks it). */
  folder?: string;
  model?: string;
}

export interface ChatFirstDeps {
  laneGet: () => Promise<AcpLaneView>;
  startChat: (agentId: string, folder: string, accountId?: string) => Promise<string>;
  setModel?: (paneId: string, model: string) => Promise<string | null>;
}

export const realChatFirstDeps = (api: Pick<AcpChatApi, 'laneGet'> = tauriAcpChatApi): ChatFirstDeps => ({
  laneGet: () => api.laneGet(),
  startChat: startChatSession,
  setModel: (paneId, model) => setChatModelOn(paneId, model),
});

export type ChatFirstResult =
  /** A chat started. `note` is one plain sentence about the model, when it could not be set. */
  | { kind: 'started'; paneId: string; note?: string }
  /** The agent has no chat that can start: the caller starts the terminal as it did before (an agent the person already runs). */
  | { kind: 'no-chat' }
  /** The chat could not start: one plain sentence. */
  | { kind: 'failed'; sentence: string };

/** Starts the agent as a chat when it can. Never throws. */
export async function startChatFirst(req: ChatFirstRequest, deps: ChatFirstDeps): Promise<ChatFirstResult> {
  let view: AcpLaneView;
  try {
    view = await deps.laneGet();
  } catch {
    return { kind: 'no-chat' }; // no answer: do what the app did before
  }
  if (!canChat(view, req.agentId)) return { kind: 'no-chat' };
  try {
    const paneId = req.accountId === undefined ? await deps.startChat(req.agentId, req.folder ?? '') : await deps.startChat(req.agentId, req.folder ?? '', req.accountId);
    const model = req.model?.trim();
    let note: string | undefined;
    if (model && deps.setModel) note = (await deps.setModel(paneId, model).catch(() => t('chatFirst.modelNotSet', { model }))) ?? undefined;
    return { kind: 'started', paneId, ...(note ? { note } : {}) };
  } catch (error) {
    const sentence = errorCode(error) === 'ACP_ADDON_MISSING' ? t('chatFirst.addonFirst') : startFailure(error).sentence;
    return { kind: 'failed', sentence };
  }
}
