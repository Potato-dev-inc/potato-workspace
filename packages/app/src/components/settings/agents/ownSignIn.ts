// How an agent's OWN login stands, for its card: Signed in / Not signed in / Can't tell (with the reason in plain words).
// The desktop reads file names or a status command's yes/no (`agent_login_states`); a usage row that says "expired" turns a
// found login into "Not signed in". Nothing here sees a credential.
import { invoke } from '@tauri-apps/api/core';
import type { Host } from '../../../lib/host/host';
import { t } from '../../../i18n';
import type { UsageRow } from '../../../lib/usage';

export interface OwnLogin {
  agent_id: string;
  state: 'signed_in' | 'signed_out' | 'unknown';
  why: string | null;
}

/** The same read at one place (`agent_login_states` is a Watch row on a far PC). */
export const ownLoginApiFor = (host: Pick<Host, 'invoke' | 'place'>) =>
  host.place.kind === 'local' ? ownLoginApi : { states: (fresh = false) => host.invoke<OwnLogin[]>('agent_login_states', { fresh }) };

export const ownLoginApi = {
  /** `fresh`: ask again even if the agent's status was asked a few minutes ago (right after a sign-in). */
  states: (fresh = false) => invoke<OwnLogin[]>('agent_login_states', { fresh }),
};

export interface OwnSignedState {
  kind: 'in' | 'out' | 'cant';
  /** The reason, for "out" (expired) and "can't tell". */
  why: string | null;
}

/** `logins` is null until the desktop answered (or when it cannot): "can't tell", never a guess. */
export function ownSignedState(row: { id: string; label: string; state: string }, logins: OwnLogin[] | null, usage: UsageRow[]): OwnSignedState {
  const found = logins?.find((l) => l.agent_id === row.id);
  if (!found) return { kind: 'cant', why: t(logins === null ? 'agentCard.notLooked' : 'agentCard.noWay', { label: row.label }) };
  if (found.state === 'signed_out') return { kind: 'out', why: null };
  if (found.state === 'signed_in') {
    const mine = usage.find((u) => u.agent_id === row.id && u.account_id == null && !u.link);
    return mine?.state === 'expired' ? { kind: 'out', why: t('agentCard.expired') } : { kind: 'in', why: null };
  }
  // The quick health check already said it wants a sign-in: that is a real answer.
  if (row.state === 'needs_login') return { kind: 'out', why: null };
  return { kind: 'cant', why: found.why ?? t('agentCard.noWay', { label: row.label }) };
}
