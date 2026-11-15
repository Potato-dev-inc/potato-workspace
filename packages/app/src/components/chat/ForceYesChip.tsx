// Force yes, as a chip in a pane's header. Off, it is a quiet word; clicking it shows what Force yes does and asks first.
// On, it is a visible chip (risk tone) and one click turns it off. A chat keeps the switch in the app; a terminal pane keeps
// it in the app too (`agent_rules::terminal`). Nothing here answers a question: it only flips the person's own switch.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { ruleError, tauriAgentRulesApi, type AgentRulesApi } from '../../lib/agentRules';
import { tauriAcpChatApi, type AcpChatApi, type AcpChatState } from '../../lib/acpChat';
import '../../styles/cockpit-acp.css';
import { useDismissable } from '../../hooks/useDismissable';
import { placeFloating } from '../cockpit/FloatingMenu';

/** The warning's width (px), as set in cockpit-acp.css. */
const POP_W = 300;

interface Props {
  paneId: string;
  /** A chat session over ACP (its state says whether Force yes is on); otherwise a terminal pane. */
  isAcp: boolean;
  state: AcpChatState | null;
  agent: string;
  cwd: string;
  chatApi?: Pick<AcpChatApi, 'setForceYes'>;
  rulesApi?: Pick<AgentRulesApi, 'paneSetForceYes' | 'paneForceYes'>;
}

export function ForceYesChip({ paneId, isAcp, state, agent, cwd, chatApi = tauriAcpChatApi, rulesApi = tauriAgentRulesApi }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pick shows at once; what the backend says replaces it, and a refusal takes it back.
  const [pending, setPending] = useState<boolean | null>(null);
  const [terminalOn, setTerminalOn] = useState<boolean | null>(null);
  // Where the warning goes (window pixels). It is drawn in the app's top layer, not inside the header: the header
  // clips its overflow, so a warning inside it was cut off under the header and the rail.
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isAcp) return undefined;
    let alive = true;
    rulesApi
      .paneForceYes(paneId, agent, cwd)
      .then((on) => alive && setTerminalOn(on))
      .catch(() => alive && setTerminalOn(false));
    return () => {
      alive = false;
    };
  }, [isAcp, paneId, agent, cwd, rulesApi]);
  const confirmed = isAcp ? (state?.forceYes ?? false) : terminalOn;
  useEffect(() => setPending(null), [confirmed, paneId]);

  useDismissable(open, { inside: [wrap, pop], anchor: wrap, onDismiss: () => setOpen(false) });

  // Under the chip, lined up with its start edge; above it when there is no room below. Measured again on resize.
  const measure = () => {
    const anchor = wrap.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const size = { width: POP_W, height: pop.current?.offsetHeight ?? 0 };
    const p = placeFloating(r, size, { width: window.innerWidth, height: window.innerHeight }, 'start', 'down');
    setPlace({ left: p.left, top: p.top });
  };
  useLayoutEffect(() => {
    if (open) measure();
    else setPlace(null);
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  // A chat that has not reported yet, or one that is closed, has nothing to switch; a terminal pane waits for its answer.
  if (isAcp ? !state || state.closed || !chatApi.setForceYes : confirmed === null) return null;
  const on = pending ?? confirmed ?? false;

  const set = (next: boolean) => {
    setError(null);
    setBusy(true);
    setPending(next);
    const sent = isAcp ? chatApi.setForceYes!(paneId, next).then(() => undefined) : rulesApi.paneSetForceYes(paneId, next).then((v) => setTerminalOn(v));
    sent
      .catch((e: unknown) => {
        setPending(null);
        setError(t('forceYes.failed', { why: ruleError(e) }));
      })
      .finally(() => setBusy(false));
  };
  const click = () => (on ? set(false) : setOpen((v) => !v));

  const warning =
    open && !on ? (
      <div
        ref={pop}
        className="fy-pop"
        role="dialog"
        aria-label={t('forceYes.warnTitle')}
        data-testid="force-yes-warning"
        style={{ position: 'fixed', left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? undefined : 'hidden' }}
      >
        <p className="fy-pop-title">{t('forceYes.warnTitle')}</p>
        <p>{t('forceYes.warnBody')}</p>
        <div className="fy-actions">
          <button type="button" className="ck-btn ck-btn--secondary" onClick={() => setOpen(false)}>
            {t('forceYes.cancel')}
          </button>
          <button
            type="button"
            className="ck-btn"
            data-testid="force-yes-confirm"
            onClick={() => {
              setOpen(false);
              set(true);
            }}
          >
            {t('forceYes.turnOn')}
          </button>
        </div>
      </div>
    ) : null;

  return (
    <span className="fy-wrap" ref={wrap}>
      <button
        type="button"
        className={`ck-chip-label fy-chip${on ? ' is-risk' : ''}`}
        data-testid="force-yes-chip"
        data-on={on ? 'true' : 'false'}
        aria-pressed={on}
        aria-haspopup={on ? undefined : 'dialog'}
        aria-expanded={on ? undefined : open}
        title={on ? t('forceYes.chipOnTip') : t('forceYes.chipOffTip')}
        disabled={busy}
        onClick={click}
      >
        {on ? t('forceYes.chipOn') : t('forceYes.chip')}
      </button>
      {warning && createPortal(warning, document.querySelector('.cockpit') ?? document.body)}
      {error && (
        <span className="fy-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
