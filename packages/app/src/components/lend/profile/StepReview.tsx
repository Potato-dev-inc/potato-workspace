import { useT } from '../../../i18n';
import { agentLabel, durationWords, type LendProfile, type LendState } from '../../../lib/lend';
import type { LendHow, LendStep } from '../../../lib/lendDraft';

export type SignedLine = { state: 'checking' } | { state: 'signed_in'; identity: string | null } | { state: 'signed_out' };

/** Step 4: the summary, every line with Change. Nothing is lent yet; the note says where the other PC asks for it. */
export function StepReview({
  state,
  p,
  how,
  signed,
  members,
  onGo,
}: {
  state: LendState;
  p: LendProfile;
  how: LendHow;
  signed: SignedLine;
  members: { id: string; name: string }[];
  onGo: (step: LendStep) => void;
}) {
  const t = useT();
  const agent = p.agent_ids[0] ? agentLabel(state, p.agent_ids[0]) : '';
  const who =
    p.who === 'my_pcs'
      ? t('lend.who.myOtherPcs')
      : p.member_ids.length > 0
        ? p.member_ids.map((id) => members.find((m) => m.id === id)?.name ?? id).join(', ')
        : t('lend.who.teammates');
  const signLine =
    how === 'key'
      ? t('lend.review.keyLine')
      : signed.state === 'signed_in'
        ? signed.identity
          ? t('lend.signin.doneAs', { who: signed.identity })
          : t('lend.signin.done')
        : signed.state === 'signed_out'
          ? t('lend.review.signedOut')
          : t('lend.review.checking');
  const row = (step: LendStep, text: string, key: string, testId?: string) => (
    <li key={key}>
      <span data-testid={testId}>{text}</span>
      <button type="button" className="lend-btn is-plain is-small" aria-label={`${t('lend.review.change')}: ${text}`} onClick={() => onGo(step)}>
        {t('lend.review.change')}
      </button>
    </li>
  );
  return (
    <div className="lend-step" data-step="review">
      <h3 className="lend-step-title">{t('lend.review.title')}</h3>
      <ul className="lend-summary">
        {row(1, p.name, 'name', 'lend-review-name')}
        {row(2, `${agent} · ${signLine}`, 'signin', 'lend-review-signin')}
        {row(
          3,
          t('lend.review.whoLine', { who, time: durationWords(p.default_secs), how: p.approval === 'each' ? t('lend.review.asksFirst') : t('lend.review.atOnce') }),
          'who',
        )}
        {row(3, p.keep_awake ? t('lend.review.awake') : t('lend.review.mayDoze'), 'awake')}
      </ul>
      <p className="lend-note">{t('lend.review.note', { name: p.name })}</p>
    </div>
  );
}
