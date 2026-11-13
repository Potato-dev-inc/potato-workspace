import { useState } from 'react';
import { useT } from '../../i18n';
import { agentLabel, capFor, durationProblem, errText, lendApi, quoted, requestTitle, type LendApi, type LendProfile, type LendRequest, type LendState } from '../../lib/lend';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { CardButton, InboxCard } from '../cockpit/InboxCard';
import { DurationField } from './Duration';
import { LendWarning } from './OwnRiskBox';
import '../../styles/lend.css';

/** The profiles that could answer this request: they lend that agent, to that kind of borrower. */
export function profilesFor(state: Pick<LendState, 'profiles'>, r: LendRequest): LendProfile[] {
  return state.profiles.filter((p) => {
    if (!p.agent_ids.includes(r.agent_id)) return false;
    if (p.who === 'my_pcs') return !r.for_other_person;
    return r.for_other_person && (p.member_ids.length === 0 || p.member_ids.includes(r.member_id));
  });
}

/**
 * A request for usage, in Inbox > Team. Everything in it came from another PC: plain text only, the reason always in
 * quotes. Lend (with a profile picker when there are several), Change time, Say no. When the borrower is another person
 * the "Use at your own risk" box shows inline and Lend waits for the tick.
 */
export function IncomingRequestCard({
  request,
  state,
  api = lendApi,
  now,
  onDone,
}: {
  request: LendRequest;
  state: LendState;
  api?: LendApi;
  now: number;
  onDone?: () => void;
}) {
  const t = useT();
  const profiles = profilesFor(state, request);
  const [profileId, setProfileId] = useState('');
  const [changing, setChanging] = useState(false);
  const [secs, setSecs] = useState(request.secs);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const agent = agentLabel(state, request.agent_id);
  const cap = Math.min(capFor(request.for_other_person), profile?.max_secs ?? Infinity);
  const timeProblem = durationProblem(secs, request.for_other_person) ?? (secs > cap ? t('lend.incoming.tooLong') : null);
  const canLend = !!profile && !busy && !timeProblem && (!request.for_other_person || understood);

  const run = async (what: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await what();
      onDone?.();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <InboxCard
      kind="lend"
      glyph="needs"
      guard
      title={requestTitle(request, agent)}
      age={now - request.at_ms}
      reason={request.reason ? quoted(request.reason) : undefined}
      data={{ 'data-lend-request': request.id }}
      body={
        <>
          {request.for_other_person && <LendWarning agent={agent} checked={understood} onChange={setUnderstood} />}
          {profiles.length > 1 && (
            <label className="lend-field">
              <span>{t('lend.incoming.lendWith')}</span>
              <select aria-label={t('lend.incoming.lendWith')} value={profile?.id ?? ''} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {profiles.length === 0 && (
            <p className="ib-note">
              {t('lend.incoming.noProfile', { agent, who: request.for_other_person ? t('lend.incoming.teammates') : t('lend.incoming.yourPcs') })}{' '}
              <button type="button" className="lend-btn is-plain is-small" onClick={() => openSettingsAt('lend')}>
                {t('lend.incoming.openSettings')}
              </button>
            </p>
          )}
          {changing && <DurationField secs={secs} onChange={setSecs} forOther={request.for_other_person} label={t('lend.incoming.lendFor')} maxSecs={profile?.max_secs} />}
          {error && (
            <p className="ib-error" role="alert">
              {error}
            </p>
          )}
        </>
      }
      actions={
        <>
          <CardButton tone="secondary" disabled={!canLend} onClick={() => void run(() => api.answer(request.id, true, profile!.id, secs === request.secs ? null : secs))}>
            {profiles.length > 1 && profile ? t('lend.incoming.lendWithName', { name: profile.name }) : t('lend.incoming.lend')}
          </CardButton>
          <CardButton tone="plain" disabled={busy} aria-expanded={changing} onClick={() => setChanging((v) => !v)}>
            {t('lend.incoming.changeTime')}
          </CardButton>
          <CardButton tone="plain" disabled={busy} onClick={() => void run(() => api.answer(request.id, false, null, null))}>
            {t('lend.incoming.sayNo')}
          </CardButton>
        </>
      }
    />
  );
}
