// One plain line under the header that says how the phone is connected. Calm when all is well: "Connected" only shows for a
// moment after a trouble ended, then goes. Every other word stays until it is true no more.
import { useT, type MessageKey } from '../../i18n';
import type { LinkKind } from '../../lib/phone-link';
import '../../styles/phone-link.css';

const WORDS: Record<LinkKind, MessageKey> = {
  connected: 'phone.link.connected',
  reconnecting: 'phone.link.reconnecting',
  asleep: 'phone.link.asleep',
  offline: 'phone.link.offline',
  changed: 'phone.link.changed',
};

export function PhoneLinkLine({ kind, recovered, unpaired = false, onPairAgain, onRetry }: { kind: LinkKind; recovered: boolean; /** No pairing is stored on this phone: say so instead of blaming the PC. */ unpaired?: boolean; onPairAgain?: () => void; /** "Try now": ask the PC again without waiting. */ onRetry?: () => void }) {
  const t = useT();
  if (kind === 'connected' && !recovered) return null;
  if (unpaired && (kind === 'reconnecting' || kind === 'asleep')) {
    return (
      <p className="ph-link" data-kind="unpaired" role="status" data-testid="phone-link-line">
        <span className="ph-link-dot" aria-hidden="true" />
        <span>{t('r11.phone.unpaired')}</span>
        {onPairAgain && (
          <button type="button" className="ph-link-btn" onClick={onPairAgain}>
            {t('r11.phone.pairNow')}
          </button>
        )}
      </p>
    );
  }
  return (
    <p className="ph-link" data-kind={kind} role="status" data-testid="phone-link-line">
      <span className="ph-link-dot" aria-hidden="true" />
      <span>{t(WORDS[kind])}</span>
      {(kind === 'reconnecting' || kind === 'asleep') && onRetry && (
        <button type="button" className="ph-link-btn" onClick={onRetry}>
          {t('phone.sh.tryNow')}
        </button>
      )}
      {kind === 'changed' && onPairAgain && (
        <button type="button" className="ph-link-btn" onClick={onPairAgain}>
          {t('phone.link.pairAgain')}
        </button>
      )}
    </p>
  );
}
