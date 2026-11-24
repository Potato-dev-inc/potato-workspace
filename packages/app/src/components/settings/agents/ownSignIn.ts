// How an agent's OWN login reads (`agent_login_states`): file names or a status command's yes/no. What it MEANS for a screen is said by
// `lib/agentReadiness.ts`. Nothing here sees a credential.
import { invoke } from '@tauri-apps/api/core';
import type { Host } from '../../../lib/host/host';

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
