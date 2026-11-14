// The four-step sheet that makes (or edits) a lend profile: Name and agent, Sign in, Who and how long, Check and save.
// It is the whole flow: the sign-in runs INSIDE it (a small terminal on a hidden pane), so nothing in it ever sends the
// person away from Settings, and the draft lives outside React (`lib/lendDraft.ts`), so closing the sheet keeps it.
// Lending is always "through my PC": the sign-in stays on this PC and only words travel (the profile's name, the agent, the time).
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { Account } from '../../lib/accounts';
import { errText, signInProblem, type LendApi, type LendProfile } from '../../lib/lend';
import { patchDraft, patchProfile, STEPS, useLendDraft, type LendHow, type LendStep } from '../../lib/lendDraft';
import type { MemberView } from '../../lib/team';
import { LendSheet } from './LendSheet';
import { StepName } from './profile/StepName';
import { StepReview, type SignedLine } from './profile/StepReview';
import { StepSignIn } from './profile/StepSignIn';
import { StepWho, whoProblem } from './profile/StepWho';
import type { LendHandle } from './useLend';
import '../../styles/lend.css';

export function LendProfileSheet({
  api,
  lend,
  accounts,
  members,
  me,
  onClose,
  onSaved,
  onAccounts,
}: {
  api: LendApi;
  lend: LendHandle;
  /** Lend sign-ins that already exist. */
  accounts: Account[];
  /** Teammates (not me). */
  members: MemberView[];
  /** My name on the team, for the "They will see" line. */
  me: string;
  /** Close the sheet; the page decides what happens to the draft. */
  onClose: () => void;
  /** The profile was saved (its name). */
  onSaved: (name: string) => void;
  onAccounts: () => void;
}) {
  const t = useT();
  const draft = useLendDraft();
  const state = lend.state;
  const [showErrors, setShowErrors] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [review, setReview] = useState<SignedLine>({ state: 'checking' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountId = draft?.accountId ?? '';
  const how = draft?.how ?? 'signin';
  const step = draft?.step ?? 1;
  const agentId = draft?.profile.agent_ids[0] ?? '';

  // The review line is live: where the sign-in stands right now, read on this PC.
  useEffect(() => {
    if (step !== 4 || how === 'key' || !accountId) {
      setReview(how === 'key' ? { state: 'signed_in', identity: null } : { state: 'signed_out' });
      return;
    }
    let alive = true;
    setReview({ state: 'checking' });
    api
      .signInStatus(accountId)
      .then((st) => alive && setReview(st.state === 'signed_in' ? { state: 'signed_in', identity: st.identity } : { state: 'signed_out' }))
      .catch(() => alive && setReview({ state: 'signed_out' }));
    return () => {
      alive = false;
    };
  }, [api, step, how, accountId]);

  if (!draft || !state) return null;
  const p = draft.profile;
  const noSignIn = signInProblem(state.drivers, [agentId]);
  const effectiveHow: LendHow = noSignIn ? 'key' : how;
  const haveKey = (draft.hadKey && !draft.removeKey) || draft.key.trim() !== '';

  const stepProblem = (s: LendStep): string | null => {
    if (s === 1) return !p.name.trim() ? t('lend.problem.name') : !agentId ? t('lend.problem.oneAgent') : null;
    if (s === 2) {
      if (effectiveHow === 'key') return haveKey ? null : t('lend.problem.key');
      return signedIn ? null : t('lend.problem.notSignedIn');
    }
    if (s === 3) return whoProblem(p, draft.understood, t);
    return null;
  };

  const go = (next: LendStep) => {
    setShowErrors(false);
    setError(null);
    patchDraft({ step: next });
  };

  const next = () => {
    if (stepProblem(step)) {
      setShowErrors(true);
      return;
    }
    go(Math.min(STEPS, step + 1) as LendStep);
  };

  // Everything must still be right when the person saves from the review (they may have used Change).
  const reviewProblem = stepProblem(1) ?? stepProblem(3) ?? (effectiveHow === 'key' ? (haveKey ? null : t('lend.problem.key')) : review.state === 'signed_in' ? null : review.state === 'checking' ? t('lend.review.checking') : t('lend.review.signedOut'));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const forOther = p.who === 'teammates';
      const usesKey = effectiveHow === 'key';
      const account: LendProfile['account'] = usesKey ? { kind: 'main' } : { kind: 'account', id: accountId };
      const saved = await api.profileSave({
        ...p,
        account,
        name: p.name.trim(),
        agent_ids: [agentId],
        member_ids: forOther ? p.member_ids : [],
        max_requests: p.max_requests || null,
        max_tokens: p.max_tokens || null,
        has_key: undefined,
      });
      // The profile exists now: a retry after a failed key save must not make a second one.
      patchProfile({ id: saved.id });
      if (usesKey && draft.key.trim()) await api.keySet(saved.id, draft.key.trim());
      else if ((!usesKey && draft.hadKey) || draft.removeKey) await api.keySet(saved.id, '');
      lend.refresh();
      onSaved(saved.name);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  const heading = draft.editing ? t('lend.editLendProfile') : t('lend.newLendProfile');
  const head = (
    <div className="lend-steps" data-testid="lend-steps">
      <span className="lend-muted">{t('lend.step', { n: step, total: STEPS })}</span>
      <ol className="lend-dots-row" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <li key={n} data-state={n === step ? 'active' : n < step ? 'done' : undefined} />
        ))}
      </ol>
      <button type="button" className="lend-btn is-plain is-small" onClick={onClose} aria-label={t('lend.close')}>
        ✕
      </button>
    </div>
  );

  return (
    <LendSheet title={heading} labelledBy="lend-profile-t" size="wide" head={head} onClose={onClose}>
      {step === 1 && (
        <StepName
          state={state}
          owner={me}
          name={p.name}
          agentId={agentId}
          showErrors={showErrors}
          onName={(name) => patchProfile({ name })}
          onAgent={(id) => {
            if (id === agentId) return;
            // A sign-in belongs to one agent: picking another starts the sign-in step fresh.
            patchDraft({ profile: { ...p, agent_ids: [id], account: { kind: 'account', id: '' } }, accountId: '', how: 'signin', key: '', removeKey: false });
            setSignedIn(false);
          }}
        />
      )}
      {step === 2 && (
        <>
          <StepSignIn
            api={api}
            state={state}
            draft={draft}
            accounts={accounts}
            onHow={(h) => patchDraft({ how: h })}
            onAccount={(id) => {
              patchDraft({
                accountId: id,
                profile: { ...p, account: { kind: 'account', id } },
                createdId: id && how === 'signin' ? id : id === '' && draft.createdId === accountId ? '' : draft.createdId,
              });
              onAccounts();
            }}
            onKey={(key) => patchDraft({ key })}
            onRemoveKey={(removeKey) => patchDraft({ removeKey })}
            onSignedIn={(ok) => setSignedIn(ok)}
          />
          {showErrors && stepProblem(2) && (
            <p className="lend-error" role="alert">
              {stepProblem(2)}
            </p>
          )}
        </>
      )}
      {step === 3 && (
        <StepWho
          state={state}
          p={p}
          members={members}
          understood={draft.understood}
          onUnderstood={(understood) => patchDraft({ understood })}
          onChange={(patch) => patchProfile(patch)}
          showErrors={showErrors}
        />
      )}
      {step === 4 && <StepReview state={state} p={p} how={effectiveHow} signed={review} members={members} onGo={go} />}
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
      {step === 4 && reviewProblem && review.state !== 'checking' && (
        <p className="lend-error" role="status">
          {reviewProblem}
        </p>
      )}
      <div className="lend-actions">
        {step === 1 ? (
          <button type="button" className="lend-btn is-plain" onClick={onClose} disabled={busy}>
            {t('lend.cancel')}
          </button>
        ) : (
          <button type="button" className="lend-btn is-plain" onClick={() => go((step - 1) as LendStep)} disabled={busy}>
            {t('lend.back')}
          </button>
        )}
        {step < 4 ? (
          <button type="button" className="lend-btn is-primary" onClick={next}>
            {t('lend.next')}
          </button>
        ) : (
          <button type="button" className="lend-btn is-primary" disabled={busy || reviewProblem !== null} onClick={() => void save()}>
            {t('lend.saveProfile')}
          </button>
        )}
      </div>
    </LendSheet>
  );
}
