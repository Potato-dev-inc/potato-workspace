// Force yes, as a chip in a pane's header. Off, it is a quiet word; clicking it shows what Force yes does and asks first.
// On, it is a visible chip (risk tone) and one click turns it off. A chat keeps the switch in the app; a terminal pane keeps
// it in the app too (`agent_rules::terminal`). Nothing here answers a question: it only flips the person's own switch.
import { useEffect, useRef, useState } from 'react';
import { useHost } from '../../lib/host/context';
import { useT } from '../../i18n';
import { ruleError, tauriAgentRulesApi, type AgentRulesApi } from '../../lib/agentRules';
import { tauriAcpChatApi, type AcpChatApi, type AcpChatState } from '../../lib/acpChat';
import '../../styles/cockpit-acp.css';
import { Popover } from '../common/Floating';

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
  // A place that does not let this person change this draws the same chip switched off, with its one reason.
  const host = useHost();
  const denied = host.denied?.('change') ?? null;
  // A far PC that does not count this PC as its person's own does not let Force yes be turned on from here (it auto-approves commands).
  const [notOwn, setNotOwn] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void host.forceYesDenied?.().then((why) => alive && setNotOwn(why));
    return () => {
      alive = false;
    };
  }, [host]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pick shows at once; what the backend says replaces it, and a refusal takes it back.
  const [pending, setPending] = useState<boolean | null>(null);
  const [terminalOn, setTerminalOn] = useState<boolean | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);

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
      <Popover anchorRef={wrap} align="start" className="fy-pop" label={t('forceYes.warnTitle')} testId="force-yes-warning" onClose={() => setOpen(false)}>
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
      </Popover>
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
        title={denied ?? (!on && notOwn ? notOwn : on ? t('forceYes.chipOnTip') : t('forceYes.chipOffTip'))}
        disabled={busy || denied !== null || (!on && notOwn !== null)}
        onClick={click}
      >
        {on ? t('forceYes.chipOn') : t('forceYes.chip')}
      </button>
      {warning}
      {error && (
        <span className="fy-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
