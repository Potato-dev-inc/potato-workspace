import { useState } from 'react';
import { useT } from '../../i18n';
import { agentLabel, capFor, durationProblem, errText, lendApi, quoted, requestTitle, type LendApi, type LendProfile, type LendRequest, type LendState } from '../../lib/lend';
import { openSettingsAt } from '../../lib/openSettingsAt';
import { CardButton, InboxCard } from '../cockpit/InboxCard';
import { DisabledReason } from '../common/DisabledReason';
import { DurationField } from './Duration';
import { LendWarning } from './OwnRiskBox';
import '../../styles/lend.css';

/** Agent ids match without case, like the backend. */
const lendsAgent = (p: LendProfile, r: LendRequest) => p.agent_ids.some((a) => a.toLowerCase() === r.agent_id.toLowerCase());
const COPY_SUFFIX = ' (my PCs)';

/** The profiles that could answer this request: they lend that agent, to that kind of borrower. */
export function profilesFor(state: Pick<LendState, 'profiles'>, r: LendRequest): LendProfile[] {
  return state.profiles.filter((p) => {
    // The borrower named one of my profiles (it picked it from what I offered): only that one can answer.
    if (r.profile_id && p.id !== r.profile_id) return false;
    if (!lendsAgent(p, r)) return false;
    if (p.who === 'my_pcs') return !r.for_other_person;
    return r.for_other_person && (p.member_ids.length === 0 || p.member_ids.includes(r.member_id));
  });
}

/**
 * Rules that lend this agent but only to teammates, when the asker is one of my own PCs. They cannot answer it (the
 * backend matches the audience exactly), but they are the rule the owner most likely meant: offer to copy it for my PCs.
 */
export function teammateOnlyProfilesFor(state: Pick<LendState, 'profiles'>, r: LendRequest): LendProfile[] {
  if (r.for_other_person) return [];
  return state.profiles.filter((p) => p.who === 'teammates' && lendsAgent(p, r) && (!r.profile_id || p.id === r.profile_id));
}

/** The reverse: a teammate asks, and the only rules for that agent are for my own PCs or for other people. */
export function otherAudienceProfilesFor(state: Pick<LendState, 'profiles'>, r: LendRequest): LendProfile[] {
  if (!r.for_other_person) return [];
  return state.profiles.filter((p) => lendsAgent(p, r) && (!r.profile_id || p.id === r.profile_id));
}

/** The copy for my PCs: same sign-in, time, limits and approval; only the audience changes. The name stays within 60. */
export function copyForMyPcs(p: LendProfile, name: (base: string) => string): LendProfile {
  return { ...p, id: '', name: name(p.name.slice(0, 60 - COPY_SUFFIX.length).trimEnd()), who: 'my_pcs', member_ids: [] };
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
  onAnswering,
}: {
  request: LendRequest;
  state: LendState;
  api?: LendApi;
  now: number;
  onDone?: () => void;
  /** The person pressed Lend or No: the card is gone at once (the answer takes a few seconds to settle). `false`: it failed, the card is back. */
  onAnswering?: (sending: boolean) => void;
}) {
  const t = useT();
  const profiles = profilesFor(state, request);
  const [profileId, setProfileId] = useState('');
  const [changing, setChanging] = useState(false);
  const [secs, setSecs] = useState(request.secs);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teammateOnly = profiles.length === 0 ? teammateOnlyProfilesFor(state, request)[0] : undefined;
  const otherAudience = profiles.length === 0 && !teammateOnly ? otherAudienceProfilesFor(state, request)[0] : undefined;
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const agent = agentLabel(state, request.agent_id);
  const cap = Math.min(capFor(request.for_other_person), profile?.max_secs ?? Infinity);
  const timeProblem = durationProblem(secs, request.for_other_person) ?? (secs > cap ? t('lend.incoming.tooLong') : null);
  const canLend = !!profile && !busy && !timeProblem && (!request.for_other_person || understood);
  // Why Lend is off, said on screen (not only on hover).
  const lendReason = canLend || busy ? null : !profile ? (teammateOnly ? t(teammateOnly.has_key ? 'lend.incoming.teammatesOnlyKeyShort' : 'lend.incoming.teammatesOnlyShort') : otherAudience ? t('lend.incoming.otherAudienceShort') : t('lend.incoming.pickProfile')) : timeProblem ?? (request.for_other_person && !understood ? t('lend.tickFirst') : null);

  // The borrower named the teammates rule, but its copy for my PCs is already saved: say so instead of offering another.
  const copyName = (base: string) => t('lend.incoming.myPcsCopy', { name: base });
  const alreadyCopied = !!teammateOnly && state.profiles.some((p) => p.who === 'my_pcs' && lendsAgent(p, request) && p.name === copyForMyPcs(teammateOnly, copyName).name);

  // One tap: a copy of that rule for my own PCs (same sign-in, time and limits), then the card re-reads and Lend is on.
  const allowMyPcs = () =>
    run(() => api.profileSave(copyForMyPcs(teammateOnly!, copyName)), true);

  const run = async (what: () => Promise<unknown>, stayOpen = false) => {
    setBusy(true);
    setError(null);
    if (!stayOpen) {
      setAnswered(true);
      onAnswering?.(true);
    }
    try {
      await what();
      onDone?.();
      // The card stays (the request is still open): the refreshed state now holds the copy, so Lend can turn on.
      if (stayOpen) setBusy(false);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
      if (!stayOpen) {
        setAnswered(false);
        onAnswering?.(false);
      }
    }
  };

  if (answered) return null;
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
          {profiles.length === 0 && teammateOnly && (
            <p className="ib-note" data-lend-teammates-only>
              {t(teammateOnly.has_key ? 'lend.incoming.teammatesOnlyKey' : 'lend.incoming.teammatesOnly', { name: teammateOnly.name })}{' '}
              {teammateOnly.has_key ? (
                <button type="button" className="lend-btn is-plain is-small" onClick={() => openSettingsAt('lend')}>
                  {t('lend.incoming.openSettings')}
                </button>
              ) : alreadyCopied ? (
                <span data-lend-already-copied>{t('lend.incoming.alreadyMyPcs')}</span>
              ) : (
                <button type="button" className="lend-btn is-plain is-small" disabled={busy} onClick={() => void allowMyPcs()}>
                  {t('lend.incoming.allowMyPcs')}
                </button>
              )}
            </p>
          )}
          {profiles.length === 0 && otherAudience && (
            <p className="ib-note" data-lend-other-audience>
              {t(otherAudience.who === 'my_pcs' ? 'lend.incoming.myPcsOnly' : 'lend.incoming.otherPeopleOnly', { name: otherAudience.name, who: request.member_name })}{' '}
              <button type="button" className="lend-btn is-plain is-small" onClick={() => openSettingsAt('lend')}>
                {t('lend.incoming.openSettings')}
              </button>
            </p>
          )}
          {profiles.length === 0 && !teammateOnly && !otherAudience && (
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
          <DisabledReason reason={lendReason} />
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
