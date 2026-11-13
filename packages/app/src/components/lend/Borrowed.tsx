import { useEffect, useRef, useState } from 'react';
import { t, useT } from '../../i18n';
import { agentLabel, borrowedBillingNote, chipText, chipLabelOf, errText, grantLine, isActiveIn, isActiveOut, leftText, lendApi, problemText, urgencyOf, usageText, WARN_ONE, WARN_TEN, type Grant, type LendApi } from '../../lib/lend';
import { useLend, type LendHandle } from './useLend';
import { TestLink } from './TestLink';
import '../../styles/lend.css';

/** Active lends with this member, both ways, as short lines with Revoke or Give back. Used in Settings > Team's People list. */
export function MemberLends({ memberId, lend, api = lendApi }: { memberId: string; lend: LendHandle; api?: LendApi }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = lend.state;
  if (!state) return null;
  const rows = state.grants.filter((g) => g.peer_member_id === memberId && (isActiveOut(g, lend.now) || isActiveIn(g, lend.now)));
  if (rows.length === 0) return null;
  const act = async (g: Grant) => {
    setBusy(g.id);
    setError(null);
    try {
      await (g.direction === 'out' ? api.revoke(g.id) : api.giveBack(g.id));
      lend.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ul className="lend-lends" aria-label={t('lend.active')}>
        {rows.map((g) => (
          <li key={g.id}>
            <span>
              {grantLine(g, agentLabel(state, g.agent_id), lend.now)}
              {problemText(g) && (
                <small className="lend-problem" role="status">
                  {problemText(g)}
                </small>
              )}
            </span>
            <TestLink grantId={g.id} api={api} />
            <button type="button" className="lend-btn is-small" disabled={busy === g.id} onClick={() => void act(g)}>
              {g.direction === 'out' ? t('phone.device.revoke') : t('lend.giveBack')}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="lend-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The time-left chip in the header of a pane that runs on a borrowed sign-in: "Leo's Claude · 1h 59m".
 * Amber at 10 minutes, red at 1. Clicking it opens the details with "Give back now". Nothing for any other pane.
 */
export function BorrowedChip({ paneId, api = lendApi, lend }: { paneId: string; api?: LendApi; lend?: LendHandle }) {
  const t = useT();
  const own = useLend(api);
  const handle = lend ?? own;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const state = handle.state;
  const grant = state?.grants.find((g) => isActiveIn(g, handle.now) && g.pane_ids.includes(paneId));
  if (!state || !grant) return null;
  const agent = agentLabel(state, grant.agent_id);
  const left = grant.ends_ms - handle.now;
  const problem = problemText(grant);
  const used = usageText(grant);

  const giveBack = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.giveBack(grant.id);
      setOpen(false);
      handle.refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="lend-chip-wrap" ref={wrap}>
      <button type="button" className="lend-chip" data-urgency={urgencyOf(left)} data-problem={problem ? 'true' : undefined} title={problem ?? undefined} data-testid="lend-chip" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {chipText(grant, agent, handle.now)}
      </button>
      {open && (
        <div className="lend-pop" role="dialog" aria-label={t('lend.borrowedSignIn')}>
          <p className="lend-pop-title">{chipLabelOf(grant, agent)}</p>
          <p>{t('lend.timeLeftStops', { time: leftText(left) })}</p>
          <p className="lend-note" data-testid="lend-billing-note">
            {borrowedBillingNote(grant.peer_name)}
          </p>
          {used && (
            <p className="lend-usage" data-testid="lend-usage">
              {t('lend.usedSoFar', { used })}
            </p>
          )}
          {problem && (
            <p className="lend-error" role="status" data-testid="lend-problem">
              {problem}
            </p>
          )}
          {grant.for_other_person && <p className="lend-note">{t('lend.repliesFrom', { peer: grant.peer_name })}</p>}
          {error && (
            <p className="lend-error" role="alert">
              {error}
            </p>
          )}
          <div className="lend-actions">
            <button type="button" className="lend-btn is-primary" disabled={busy} onClick={() => void giveBack()}>
              {t('lend.giveBackNow')}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * Toasts at 10 minutes and 1 minute left on a lend I borrow: "Finish or save now". Each fires once per lend.
 * `notify` is the cockpit's toast.
 */
export function useLendToasts(lend: LendHandle, notify: (text: string) => void): void {
  const sent = useRef(new Set<string>());
  const state = lend.state;
  useEffect(() => {
    if (!state) return;
    for (const g of state.grants) {
      if (!isActiveIn(g, lend.now)) continue;
      const left = g.ends_ms - lend.now;
      const who = t('lend.ownerOf', { person: g.peer_name, device: agentLabel(state, g.agent_id) });
      // The 1-minute one wins when both are due at once (a lend that started late).
      if (left <= WARN_ONE.minutes * 60_000) {
        if (!sent.current.has(`${g.id}:1`)) {
          sent.current.add(`${g.id}:1`);
          sent.current.add(`${g.id}:10`);
          notify(t('lend.warnOne', { who }));
        }
      } else if (left <= WARN_TEN.minutes * 60_000 && !sent.current.has(`${g.id}:10`)) {
        sent.current.add(`${g.id}:10`);
        notify(t('lend.warnTen', { who, time: leftText(left) }));
      }
    }
  }, [state, lend.now, notify]);
}
