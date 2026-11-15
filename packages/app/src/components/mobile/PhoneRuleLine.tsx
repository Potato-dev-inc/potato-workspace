// One small line above the message box, with a lock, when something here is not allowed on this phone: the PC's rule for this
// agent (off / watch only / watch and answer), or this phone's own missing ability (cannot stop or close, cannot answer).
// Nothing is shown when everything is allowed. It never names an agent: the rule comes from the PC's agent settings.
import { useT } from '../../i18n';
import type { RuleLimit } from '../../lib/pane-rule-view';
import '../../styles/phone-shell.css';

export function PhoneRuleLine({ limit, canControl = true, canAnswer = true }: { limit: RuleLimit | null; canControl?: boolean; canAnswer?: boolean }) {
  const t = useT();
  const text =
    limit === 'off' ? t('phone.lock.off')
    : limit === 'watch' ? t('phone.lock.watch')
    : limit === 'answer' ? t('phone.lock.answer')
    : !canAnswer ? t('phone.rule.noAnswer')
    : !canControl ? t('phone.rule.noControl')
    : null;
  if (!text) return null;
  return (
    <p className="ph-ruleline" data-testid="phone-rule-line" data-limit={limit ?? 'ability'}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <span>{text}</span>
    </p>
  );
}
