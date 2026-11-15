import type { Account } from '../../../lib/accounts';
import { agentLabel, signInProblem, type LendApi, type LendState } from '../../../lib/lend';
import { useT } from '../../../i18n';
import type { LendDraft, LendHow } from '../../../lib/lendDraft';
import { SignInStep } from '../SignInStep';

/**
 * Step 2: the sign-in, inside the sheet. A thin wrapper: the draft decides what is shown (the agent, the account, the key),
 * `SignInStep` runs the sign-in on its hidden pane and tells whether it can be lent.
 */
export function StepSignIn({
  api,
  state,
  draft,
  accounts,
  onHow,
  onAccount,
  onKey,
  onRemoveKey,
  onSignedIn,
}: {
  api: LendApi;
  state: LendState;
  draft: LendDraft;
  accounts: Account[];
  onHow: (how: LendHow) => void;
  onAccount: (id: string) => void;
  onKey: (key: string) => void;
  onRemoveKey: (v: boolean) => void;
  onSignedIn: (ok: boolean, identity: string | null) => void;
}) {
  const t = useT();
  const agentId = draft.profile.agent_ids[0] ?? '';
  const name = agentLabel(state, agentId);
  const noSignIn = signInProblem(state.drivers, [agentId]);
  // Each lend sign-in is told apart by the profile that uses it (never by its internal label).
  const profileNames: Record<string, string> = {};
  for (const p of state.profiles) if (p.account.kind === 'account') profileNames[p.account.id] = p.name;
  if (draft.accountId && draft.profile.name.trim()) profileNames[draft.accountId] = draft.profile.name.trim();
  for (const a of accounts) if (!profileNames[a.id] && a.lend_profile) profileNames[a.id] = a.lend_profile;
  return (
    <div className="lend-step" data-step="signin">
      <SignInStep
        api={api}
        agentId={agentId}
        agentName={name}
        noSignIn={noSignIn}
        how={noSignIn ? 'key' : draft.how}
        onHow={onHow}
        accountId={draft.accountId}
        onAccount={onAccount}
        accounts={accounts.filter((a) => a.agent_id === agentId)}
        newLabel={draft.profile.name.trim() || t('lend.signInLabel')}
        profileNames={profileNames}
        keyValue={draft.key}
        onKeyValue={onKey}
        hasKey={draft.hadKey}
        removeKey={draft.removeKey}
        onRemoveKey={onRemoveKey}
        onSignedIn={onSignedIn}
      />
    </div>
  );
}
