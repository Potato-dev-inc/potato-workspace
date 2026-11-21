// "Sign in again" from anywhere that is not a chat: the Usage card's expired row, the Problems list, Settings > Accounts.
// One small sheet asks the agent to sign in through a hidden pane (the lend sign-in's method, `capacity_proxy::signin_pane`).
// Nothing is added to the sidebar and no terminal pane opens in the main workspace. This file never sees a credential: it
// only asks the desktop to start, look at and stop the pane. It finds out the sign-in worked from a real sign (the desktop
// saw this login's credential file written since the sign-in started, or the usage shows a real reading for exactly this login),
// never from a timer and never from a row that merely exists.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ChatSignIn, SignInStatus } from './chatMore';
import type { Host } from './host/host';
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
export function desktopAgentSignIn(agentId: string, accountId?: string | null, host?: Pick<Host, 'invoke'>): ChatSignIn {
  const args = { agent_id: agentId, account_id: accountId || null };
  const run = <T,>(cmd: string): Promise<T> => (host ? host.invoke<T>(cmd, args) : invoke<T>(cmd, args));
  return {
    start: async () => (await run<{ pane_id: string }>('agent_signin_start')).pane_id,
    status: () => run<SignInStatus>('agent_signin_status'),
    stop: () => run<void>('agent_signin_stop'),
  };
}

/** The sign-in pair bound to one place. A far place has no usage numbers here, so only the PC's own proof counts (never this PC's usage). */
export function signInFor(host: Host): {
  signIn: (agentId: string, accountId?: string | null) => ChatSignIn;
  check: (agentId: string, accountId?: string | null) => Promise<void>;
} {
  const far = host.place.kind !== 'local';
  if (!far) return { signIn: (a, b) => desktopAgentSignIn(a, b), check: (a, b) => signedInNow(a, b) };
  const proof = (a: string, b?: string | null) => host.invoke<SignInProof>('agent_signin_status', { agent_id: a, account_id: b || null });
  return {
    signIn: (agentId, accountId) => desktopAgentSignIn(agentId, accountId, host),
    check: (agentId, accountId) => signedInNow(agentId, accountId, { snapshot: async () => ({ rows: [] }) as never }, proof),
  };
}

/** What the desktop knows about this sign-in: `signed_in` is true only with proof (the credential file was written since it started); false or null is "no proof yet" (an agent that keeps its login in a keychain never has a file). */
export interface SignInProof {
  signed_in?: boolean | null;
}

export const SIGNIN_NOT_FINISHED = 'The sign-in is not finished yet.';

/** Thrown when this agent shows no sign-in anywhere the app can look (no credential file, no usage reading): waiting would never end. */
export class SignInCannotCheck extends Error {
  constructor() {
    super('This agent cannot be checked.');
    this.name = 'SignInCannotCheck';
  }
}

/**
 * Whether the sign-in is really done. Two real signs count: the desktop saw this exact login's credential file written since the
 * sign-in started, or the usage shows a real reading (`ok` or `limited`, which needs a valid token the agent's server accepted) for
 * exactly this login (the way a keychain login, which no folder shows, is told). A row that is `unknown` (the folder is just not empty),
 * an `expired` row, another account's row and no row at all are all "not finished yet".
 * Rejects with a plain sentence while it is not, so the card keeps waiting.
 */
export async function signedInNow(
  agentId: string,
  accountId?: string | null,
  api: Pick<UsageApi, 'snapshot'> = usageApi,
  proof: (agentId: string, accountId?: string | null) => Promise<SignInProof> = (a, b) => invoke<SignInProof>('agent_signin_status', { agent_id: a, account_id: b || null }),
): Promise<void> {
  const seen = await proof(agentId, accountId).catch(() => ({}) as SignInProof);
  const read = async () => {
    const snap = await api.snapshot(true, true);
    return (Array.isArray(snap?.rows) ? snap.rows : []).filter((r) => r.agent_id === agentId && (accountId ? r.account_id === accountId : r.account_id == null));
  };
  if (seen.signed_in === true) {
    // A fresher credential file is not enough while this login's own usage row still says the sign-in is expired.
    const rows = await read().catch(() => []);
    if (rows.some((r) => r.state === 'expired')) throw new Error(SIGNIN_NOT_FINISHED);
    return;
  }
  const mine = await read();
  if (mine.some((r) => r.state === 'ok' || r.state === 'limited')) return;
  // No file can be looked at (proof is null, not false) and the only thing there is an `unknown` row: nothing will ever say "signed in".
  if (seen.signed_in === null && mine.length > 0 && mine.every((r) => r.state === 'unknown')) throw new SignInCannotCheck();
  throw new Error(SIGNIN_NOT_FINISHED);
}
