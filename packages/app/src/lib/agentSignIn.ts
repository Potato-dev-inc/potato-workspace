// "Sign in again" from anywhere that is not a chat: the Usage card's expired row, the Problems list, Settings > Accounts.
// One small sheet asks the agent to sign in through a hidden pane (the lend sign-in's method, `capacity_proxy::signin_pane`).
// Nothing is added to the sidebar and no terminal pane opens in the main workspace. This file never sees a credential: it
// only asks the desktop to start, look at and stop the pane, and finds out the sign-in worked by reading the usage again.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatSignIn, SignInStatus } from './chatMore';
import { usageApi, type UsageApi } from './usage';

export interface SignInAgainRequest {
  agentId: string;
  /** The agent's name ("Claude"). */
  label: string;
  /** One of the person's extra sign-ins; absent for the agent's normal login. */
  accountId?: string | null;
}

let current: SignInAgainRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens the sheet for this agent (a second call replaces the first). */
export function openSignInAgain(request: SignInAgainRequest): void {
  current = { agentId: request.agentId, label: request.label, accountId: request.accountId || null };
  emit();
}

export function closeSignInAgain(): void {
  if (!current) return;
  current = null;
  emit();
}

/** What the sheet is open for right now, or null (for code outside React, and tests). */
export const peekSignInAgain = (): SignInAgainRequest | null => current;

export function useSignInAgain(): SignInAgainRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}

/** The hidden sign-in of an agent (and account) with no chat behind it (`commands/chat_signin.rs`). */
export function desktopAgentSignIn(agentId: string, accountId?: string | null): ChatSignIn {
  const args = { agent_id: agentId, account_id: accountId || null };
  return {
    start: async () => (await invoke<{ pane_id: string }>('agent_signin_start', args)).pane_id,
    status: () => invoke<SignInStatus>('agent_signin_status', args),
    stop: () => invoke<void>('agent_signin_stop', args),
  };
}

/**
 * Whether the sign-in is back: the usage is read again, and the agent (and account) has a row that is not "expired".
 * Rejects with a plain sentence while it is not, so the card keeps waiting.
 */
export async function signedInNow(agentId: string, accountId?: string | null, api: Pick<UsageApi, 'snapshot'> = usageApi): Promise<void> {
  const snap = await api.snapshot(true, true);
  const rows = (Array.isArray(snap?.rows) ? snap.rows : []).filter((r) => r.agent_id === agentId && (!accountId || r.account_id === accountId));
  if (rows.length === 0 || rows.some((r) => r.state === 'expired')) throw new Error('The sign-in is still out.');
}
