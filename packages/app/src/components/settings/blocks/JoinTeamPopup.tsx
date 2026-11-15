// "Join <team>?" — what a one-time invite link opens. The link is untrusted: only a code and a host were read from it
// (lib/join-link.ts); the team name and who invited come from that Worker, are shown here as plain text, and
// the invite is not used up until the person presses Join. The team owner still approves the join afterwards.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../../i18n';
import { errorSentence } from '../../../lib/sayError';
import { joinLinkText, parseJoinLink, JOIN_LINK_EVENT } from '../../../lib/join-link';
import { teamApi, type InviteLookup, type TeamApi } from '../../../lib/team';
import { Btn, FieldInput, Note } from '../settings-ui';

type Phase = { kind: 'loading' } | { kind: 'ready'; look: InviteLookup } | { kind: 'sent'; look: InviteLookup } | { kind: 'error'; text: string };

export function JoinTeamPopup({
  link,
  api,
  guess,
  onClose,
  onJoined,
}: {
  /** What was opened: `https://<worker>/join/<code>` or the deep link. Checked again here. */
  link: string;
  api: Pick<TeamApi, 'inviteLookup' | 'inviteAccept'>;
  /** A first guess for "Your name". */
  guess: string;
  onClose: () => void;
  onJoined?: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [name, setName] = useState(guess);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseJoinLink(link);

  useEffect(() => {
    let alive = true;
    if (!parsed) {
      setPhase({ kind: 'error', text: t('join.notLink') });
      return;
    }
    if (!api.inviteLookup) {
      setPhase({ kind: 'error', text: t('join.needsNewer') });
      return;
    }
    api
      .inviteLookup(joinLinkText(parsed))
      .then((look) => alive && setPhase({ kind: 'ready', look }))
      .catch((e) => alive && setPhase({ kind: 'error', text: errorSentence(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const shownName = edited ? name : guess;
  const join = async () => {
    if (phase.kind !== 'ready' || !parsed || !api.inviteAccept) return;
    setBusy(true);
    setError(null);
    try {
      await api.inviteAccept({ link: joinLinkText(parsed), name: shownName.trim() });
      setPhase({ kind: 'sent', look: phase.look });
      onJoined?.();
    } catch (e) {
      setError(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  const look = phase.kind === 'ready' || phase.kind === 'sent' ? phase.look : null;
  const team = look?.teamName || t('join.thisTeam');
  return (
    <div className="st-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="st-sheet" role="dialog" aria-modal="true" aria-labelledby="join-popup-title" data-testid="join-popup">
        {phase.kind === 'loading' && (
          <p role="status" id="join-popup-title">
            {t('join.looking')}
          </p>
        )}
        {phase.kind === 'error' && (
          <>
            <h2 id="join-popup-title">{t('join.cant')}</h2>
            <Note role="alert">{phase.text}</Note>
            <div className="st-sheet-actions">
              <Btn onClick={onClose}>{t('join.close')}</Btn>
            </div>
          </>
        )}
        {phase.kind === 'ready' && look && (
          <>
            <h2 id="join-popup-title">{t('join.title', { team })}</h2>
            <div className="flex flex-col gap-2 py-2">
              <p>{look.inviter ? t('join.invitedBy', { who: look.inviter }) : t('join.invited')}</p>
              <p className="tp-sub">{t('join.shares')}</p>
              <p className="tp-sub">{t('join.ownerSaysYes')}</p>
              <p className="tp-sub" data-testid="join-host">
                {t('join.from', { host: look.host })}
              </p>
            </div>
            <label className="st-team-row">
              <span>{t('teamPage.yourName')}</span>
              <FieldInput
                value={shownName}
                maxLength={40}
                onChange={(e) => {
                  setEdited(true);
                  setName(e.target.value);
                }}
              />
            </label>
            {error && <Note role="alert">{error}</Note>}
            <div className="st-sheet-actions">
              <Btn disabled={busy} onClick={onClose}>
                {t('join.notNow')}
              </Btn>
              <Btn primary disabled={busy || !shownName.trim()} onClick={() => void join()}>
                {busy ? t('join.joining') : t('join.join')}
              </Btn>
            </div>
          </>
        )}
        {phase.kind === 'sent' && (
          <>
            <h2 id="join-popup-title">{t('join.sentTitle')}</h2>
            <p role="status">{t('join.sent', { who: phase.look.inviter || t('join.theOwner'), team })}</p>
            <div className="st-sheet-actions">
              <Btn primary onClick={onClose}>
                {t('join.close')}
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Every mounted host, oldest first. Only the oldest answers a link, so a window that has two (the cockpit's and the Team page's) shows one popup. */
const hosts: object[] = [];

/**
 * Opens the popup when a link is announced (`window` event `pm:join-link`, `detail` = the link). The desktop shell
 * sends it when the OS opens a `potato-workspace://join/...` link; a pasted link opens the popup directly.
 */
export function JoinLinkHost({
  api = teamApi,
  guess,
  onJoined,
}: {
  api?: Pick<TeamApi, "inviteLookup" | "inviteAccept">;
  guess: string;
  onJoined?: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const me = useRef({});
  useEffect(() => {
    const id = me.current;
    hosts.push(id);
    const on = (e: Event) => {
      if (hosts[0] !== id) return;
      const detail = (e as CustomEvent<unknown>).detail;
      // Anything that is not a valid link is dropped here, before anything is asked of the network.
      if (typeof detail === 'string' && parseJoinLink(detail)) setLink(detail);
    };
    window.addEventListener(JOIN_LINK_EVENT, on);
    return () => {
      window.removeEventListener(JOIN_LINK_EVENT, on);
      const at = hosts.indexOf(id);
      if (at >= 0) hosts.splice(at, 1);
    };
  }, []);
  if (!link) return null;
  return <JoinTeamPopup link={link} api={api} guess={guess} onClose={() => setLink(null)} onJoined={onJoined} />;
}
