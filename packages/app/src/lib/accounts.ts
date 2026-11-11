// User accounts per agent (Settings > Agents > Accounts, cockpit "+" menu). Backend: `accounts.rs`.
import { invoke } from '@tauri-apps/api/core';

export interface Account {
  id: string;
  agent_id: string;
  label: string;
  home: string;
}

/** An agent whose profile declares how it is pointed at another account. */
export interface AccountAgent {
  agent_id: string;
  login_hint: string;
  home_env: string;
}

export interface AccountsOverview {
  agents: AccountAgent[];
  accounts: Account[];
  /** Per agent id: which login a helper that agent starts uses. `ask`, `main` or an account id. Absent on an old backend. */
  helper_logins?: Record<string, string>;
}

export interface AccountsApi {
  list: () => Promise<AccountsOverview>;
  add: (agentId: string, label: string) => Promise<Account>;
  rename: (id: string, label: string) => Promise<Account>;
  remove: (id: string, deleteHome?: boolean) => Promise<boolean>;
  /** Start the agent under the account in a new pane (the one-time login). */
  openLoginPane: (agentId: string, accountId: string) => Promise<string>;
  /** Which login a helper this agent starts uses: `ask`, `main` or an account id. Returns the saved value. */
  setHelperLogin: (agentId: string, value: string) => Promise<string>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Desktop shell required: ${command}`);
  return invoke<T>(command, args);
}

export const tauriAccountsApi: AccountsApi = {
  list: () => call<AccountsOverview>('accounts_list'),
  add: (agentId, label) => call<Account>('accounts_add', { agentId, label }),
  rename: (id, label) => call<Account>('accounts_rename', { id, label }),
  remove: (id, deleteHome = false) => call<boolean>('accounts_remove', { id, deleteHome }),
  openLoginPane: (agentId, accountId) => call<string>('new_pane', { agentId, accountId }),
  setHelperLogin: (agentId, value) => call<string>('accounts_set_helper_login', { agentId, value }),
};

export function accountsFor(accounts: Account[], agentId: string): Account[] {
  return accounts.filter((a) => a.agent_id === agentId);
}

/** The cockpit "+" menu asks for an account only when the agent has one to choose. */
export function needsAccountStep(accounts: Account[], agentId: string): boolean {
  return accountsFor(accounts, agentId).length > 0;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- the sign-in used last, per agent

export const LAST_SIGN_IN_KEY = 'pm.signin.last';

/** An agent id to the sign-in it was last started with: an account id, or '' for the default sign-in. */
export type LastSignIns = Record<string, string>;

/** Reads the stored text. Anything that is not an object of strings is dropped, never thrown. */
export function parseLastSignIns(raw: string | null): LastSignIns {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

export function readLastSignIns(): LastSignIns {
  try {
    return parseLastSignIns(localStorage.getItem(LAST_SIGN_IN_KEY));
  } catch {
    return {};
  }
}

/** Remembers the sign-in this agent was started with (`undefined`: the default one). Storage that is blocked just forgets. */
export function rememberSignIn(agentId: string, accountId: string | undefined): void {
  try {
    localStorage.setItem(LAST_SIGN_IN_KEY, JSON.stringify({ ...readLastSignIns(), [agentId]: accountId ?? '' }));
  } catch {
    // Not remembered; the next start asks again.
  }
}

/**
 * Which sign-in a start can use without asking: the one used last for this agent, when it is still there.
 * `null` means ask (nothing remembered, or the remembered one was removed). `{ accountId: undefined }` is the default sign-in.
 */
export function rememberedSignIn(accounts: Account[], agentId: string, last: LastSignIns = readLastSignIns()): { accountId: string | undefined; label: string } | null {
  const v = last[agentId];
  if (v === undefined) return null;
  if (v === '') return { accountId: undefined, label: 'Default' };
  const found = accountsFor(accounts, agentId).find((a) => a.id === v);
  return found ? { accountId: found.id, label: found.label } : null;
}
