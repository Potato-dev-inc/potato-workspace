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

export function PhoneLinkLine({ kind, recovered, onPairAgain }: { kind: LinkKind; recovered: boolean; onPairAgain?: () => void }) {
  const t = useT();
  if (kind === 'connected' && !recovered) return null;
  return (
    <p className="ph-link" data-kind={kind} role="status" data-testid="phone-link-line">
      <span className="ph-link-dot" aria-hidden="true" />
      <span>{t(WORDS[kind])}</span>
      {kind === 'changed' && onPairAgain && (
        <button type="button" className="ph-link-btn" onClick={onPairAgain}>
          {t('phone.link.pairAgain')}
        </button>
      )}
    </p>
  );
}
