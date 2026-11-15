// The one-time invite link, shown over the Team page: the link, Copy, when it stops working, and a new one.
// The link itself is the secret: it is shown here, copied on request, and never logged.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import type { InviteView, TeamApi } from '../../lib/team';
import { hasWorkerLink } from './invite-slot';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function InviteSheet({
  invite,
  api,
  onNew,
  onClose,
}: {
  invite: InviteView & { joinUrl: string };
  api: Pick<TeamApi, 'invite'>;
  /** A new link replaced this one. */
  onNew: (next: InviteView & { joinUrl: string }) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.joinUrl);
      setCopied(true);
      setError(null);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t('teamPage.copyFailed'));
    }
  };
  const another = async () => {
    setMaking(true);
    setError(null);
    try {
      const next = await api.invite();
      if (hasWorkerLink(next)) {
        setCopied(false);
        onNew(next);
      } else setError(t('teamHub.inviteSheet.noLink'));
    } catch {
      setError(t('teamHub.inviteSheet.noLink'));
    } finally {
      setMaking(false);
    }
  };
  return (
    <div>
      <div className="tpg-sheet" role="dialog" aria-label={t('teamPage.inviteSomeone')} data-testid="invite-sheet">
        <h3 className="tpg-sheet-title">{t('teamPage.inviteSomeone')}</h3>
        <p className="tpg-sub">{t('teamPage.inviteWorkerLink')}</p>
        <input className="tpg-field-input" readOnly value={invite.joinUrl} aria-label={t('teamPage.linkAria')} data-testid="invite-sheet-link" onFocus={(e) => e.currentTarget.select()} />
        {error && (
          <p className="tpg-sub" role="alert">
            {error}
          </p>
        )}
        <p className="tpg-sub">{t('teamPage.expiresAt', { time: clock(invite.expiresAtMs) })}</p>
        <div className="tpg-actions">
          <button type="button" className="ck-btn ck-btn--plain" disabled={making} onClick={() => void another()}>
            {t('teamPage.newInvite')}
          </button>
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void copy()} data-testid="invite-sheet-copy">
            {copied ? t('teamPage.copied') : t('teamHub.inviteSheet.copy')}
          </button>
          <button type="button" className="ck-btn ck-btn--plain" onClick={onClose}>
            {t('teamHub.inviteSheet.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
