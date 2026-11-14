import { useState } from 'react';
import { useT } from '../../../i18n';
import { agentLabel, capFor, durationProblem, durationWords, type LendProfile, type LendState } from '../../../lib/lend';
import type { MemberView } from '../../../lib/team';
import { DurationField } from '../Duration';
import { LendWarning } from '../OwnRiskBox';

const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Why step 3 cannot go on, in a sentence, or null. Shared with the Next button. */
export function whoProblem(p: LendProfile, understood: boolean, t: ReturnType<typeof useT>): string | null {
  const forOther = p.who === 'teammates';
  const dur = durationProblem(p.default_secs, forOther) ?? durationProblem(p.max_secs, forOther);
  if (dur) return dur;
  if (p.default_secs > p.max_secs) return t('lend.problem.default');
  if (forOther && !understood) return t('lend.problem.tick');
  return null;
}

/** Step 3: who can ask, for how long each time, whether to ask first; the rest is folded under "More options". */
export function StepWho({
  state,
  p,
  members,
  understood,
  onUnderstood,
  onChange,
  showErrors,
}: {
  state: LendState;
  p: LendProfile;
  members: MemberView[];
  understood: boolean;
  onUnderstood: (v: boolean) => void;
  onChange: (patch: Partial<LendProfile>) => void;
  showErrors: boolean;
}) {
  const t = useT();
  const forOther = p.who === 'teammates';
  const [more, setMore] = useState(false);
  const problem = showErrors ? whoProblem(p, understood, t) : null;
  const agent = p.agent_ids[0] ? agentLabel(state, p.agent_ids[0]) : t('lend.agent');
  const numberField = (label: string, value: number | null | undefined, set: (n: number | null) => void) => (
    <label className="lend-field">
      <span>{label}</span>
      <input
        type="number"
        min={1}
        aria-label={label}
        className="lend-num"
        value={value ?? ''}
        placeholder={t('lend.noLimit')}
        onChange={(e) => {
          const n = Number.parseInt(e.target.value, 10);
          set(Number.isFinite(n) && n > 0 ? n : null);
        }}
      />
    </label>
  );
  return (
    <div className="lend-step" data-step="who">
      <h3 className="lend-step-title">{t('lend.who.title')}</h3>
      <fieldset className="lend-checks">
        <legend className="lend-legend">{t('lend.whoCanAsk')}</legend>
        <label className="lend-radio">
          <input type="radio" name="lend-who" checked={p.who === 'my_pcs'} onChange={() => onChange({ who: 'my_pcs' })} />
          <span>{t('lend.who.myOtherPcs')}</span>
        </label>
        <label className="lend-radio">
          <input type="radio" name="lend-who" checked={forOther} onChange={() => onChange({ who: 'teammates' })} />
          <span>{t('lend.who.teammates')}</span>
        </label>
      </fieldset>
      {forOther && (
        <>
          {members.length > 0 && (
            <fieldset className="lend-checks">
              <legend className="lend-legend">{t('lend.whichTeammates')}</legend>
              {members.map((m) => (
                <label key={m.id}>
                  <input type="checkbox" checked={p.member_ids.includes(m.id)} onChange={() => onChange({ member_ids: toggle(p.member_ids, m.id) })} />
                  <span>{m.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <LendWarning agent={agent} checked={understood} onChange={onUnderstood} />
        </>
      )}
      <DurationField
        secs={p.default_secs}
        onChange={(s) => onChange({ default_secs: s, max_secs: Math.min(capFor(forOther), Math.max(p.max_secs, s)) })}
        forOther={forOther}
        label={t('lend.each')}
      />
      <label className="lend-switch">
        <input type="checkbox" role="switch" checked={p.approval === 'each'} onChange={(e) => onChange({ approval: e.target.checked ? 'each' : 'none' })} />
        <span className="lend-card-text">
          <strong>{t('lend.askEach')}</strong>
          <small>{t('lend.askEachSub')}</small>
        </span>
      </label>
      <button type="button" className="lend-btn is-plain is-small lend-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>
        {t('lend.more')}
      </button>
      {more && (
        <div className="lend-more-body">
          <DurationField secs={p.max_secs} onChange={(s) => onChange({ max_secs: s })} forOther={forOther} label={t('lend.theMost', { time: durationWords(capFor(forOther)) })} />
          {numberField(t('lend.mostRequests'), p.max_requests, (n) => onChange({ max_requests: n }))}
          {numberField(t('lend.mostTokens'), p.max_tokens, (n) => onChange({ max_tokens: n }))}
          <label className="lend-radio">
            <input type="checkbox" checked={p.keep_awake} onChange={(e) => onChange({ keep_awake: e.target.checked })} />
            <span>{t('lend.keepAwake')}</span>
          </label>
          {p.keep_awake && <small className="lend-note">{t('lend.battery')}</small>}
          <label className="lend-radio">
            <input type="checkbox" checked={p.sign_out_on_end} onChange={(e) => onChange({ sign_out_on_end: e.target.checked })} />
            <span>{t('lend.signOutEnd')}</span>
          </label>
        </div>
      )}
      {problem && (
        <p className="lend-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
