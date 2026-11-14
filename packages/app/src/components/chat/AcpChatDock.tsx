// What a chat session over ACP adds under its conversation: the agent's permission questions as cards (the Inbox's own
// decision card, with the agent's real options), and the strips that carry a real action (stopped, interrupted,
// quiet). The plain "Working…" and its Stop live in the message box (ChatComposer). While a question is open it also holds the
// small switch that lets an agent answer these questions (off by default).
import { useEffect, useState } from 'react';
import { useAcpStop, type AcpStop } from '../../hooks/useAcpStop';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { errorSentence, interruptedStrip, permissionCards, quietStrip, runStrip, stoppedStrip, tauriAcpChatApi, type AcpChatApi } from '../../lib/acpChat';
import { kindWords, permissionOf } from '../../lib/decisionCard';
import { DecisionCard, type DecisionAnswer } from './DecisionCard';
import { AgentAnsweringSwitch } from './AgentAnsweringSwitch';
import { ErrorCard } from '../common/ErrorCard';
import { useT } from '../../i18n';
import { SignInFixCard } from '../acp/SignInFixCard';
import { pushComposerInsert } from '../../lib/composer-insert';
import '../../styles/cockpit-acp.css';

export function AcpChatDock({ c, paneId, paneName, api = tauriAcpChatApi, stopper }: { c: CockpitApi; paneId: string; paneName: string; api?: AcpChatApi; /** The Stop the message box shares (PaneView); without it the dock keeps its own. */ stopper?: AcpStop }) {
  const t = useT();
  const state = useAcpChatState(paneId, true, api);
  const running = !!state?.turnInFlight;
  // The person pressed Stop: the box reads "Stopping…" at once, before the backend's state event comes back.
  const own = useAcpStop(paneId, running, api);
  const { asked, stop } = stopper ?? own;

  // The adapter stopped by itself: one line with the reason and one button. Restart is the person's call.
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const stopped = stoppedStrip(state);
  useEffect(() => {
    if (!stopped) {
      setRestarting(false);
      setRestartError(null);
    }
  }, [stopped]);
  const restart = () => {
    if (!api.restart || restarting) return;
    setRestarting(true);
    setRestartError(null);
    api
      .restart(paneId)
      .catch((e) => setRestartError(errorSentence(e)))
      .finally(() => setRestarting(false));
  };

  // The app closed in the middle of a turn: the words are all there; Continue is the person's click.
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const interrupted = interruptedStrip(state);
  useEffect(() => {
    if (!interrupted) {
      setContinuing(false);
      setContinueError(null);
    }
  }, [interrupted]);
  const continueTurn = () => {
    if (!api.continueTurn || continuing) return;
    setContinuing(true);
    setContinueError(null);
    api
      .continueTurn(paneId)
      .catch((e) => setContinueError(errorSentence(e)))
      .finally(() => setContinuing(false));
  };

  const cards = permissionCards(c.asked.questions, paneId);
  const autoAllow = state && !state.closed ? (state.autoAllow ?? []) : [];
  // "Don't ask again" first tells the chat to remember the kind, then answers; a refusal still lets the answer go.
  const answerCard = (id: string, { choiceId, remember }: DecisionAnswer, kind: string | null) => {
    const send = () => void c.asked.answerQuestion(id, { choice_id: choiceId });
    if (remember && kind && api.setAutoAllow) api.setAutoAllow(paneId, kind, true).then(send, send);
    else send();
  };
  const turnBackOn = (kind: string) => {
    api.setAutoAllow?.(paneId, kind, false).catch(() => undefined);
  };
  // A waiting state with no card to answer is a bug state: after a short grace (the card is on its way) say so and
  // give the person a way out, instead of a chat that waits for nothing.
  const waitingNoCard = !!state && !state.closed && state.phase === 'needs_input' && cards.length === 0;
  const [orphan, setOrphan] = useState(false);
  useEffect(() => {
    if (!waitingNoCard) {
      setOrphan(false);
      return;
    }
    const timer = window.setTimeout(() => {
      console.warn('acp chat: waiting for an answer with no card on screen', paneId);
      setOrphan(true);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [waitingNoCard, paneId]);
  const quiet = quietStrip(state, asked);
  const strip = quiet ? null : runStrip(state, asked);
  const signIn = state && !state.closed && state.signIn?.needed ? state : null;
  // The first other agent that can open a visible chat or terminal; none: the card offers only "Sign in again".
  const otherAgent = signIn ? (c.launchEntries ?? []).find((e) => e.type !== signIn.agent && !e.disabled && !e.shell) : undefined;
  if (cards.length === 0 && !quiet && !signIn && !stopped && !interrupted && autoAllow.length === 0 && !orphan) return null;
  const keepWaiting = () => {
    api.keepWaiting?.(paneId).catch(() => undefined);
  };
  return (
    <div className="ck-dock ck-acp-dock" data-testid="acp-dock">
      {cards.slice(0, 1).map((q) => {
        const permission = permissionOf(q, state?.permissions);
        return (
          <DecisionCard
            key={q.id}
            q={q}
            permission={permission}
            label={state?.label ?? paneName}
            waiting={cards.length - 1}
            canRememberHere={!!api.setAutoAllow}
            onAnswer={(answer) => answerCard(q.id, answer, permission?.toolKind ?? null)}
            onDismiss={() => void c.asked.dismissQuestion(q.id)}
          />
        );
      })}
      {cards.length > 0 && <AgentAnsweringSwitch paneId={paneId} state={state} api={api} />}
      {signIn && (
        <SignInFixCard
          label={signIn.label}
          hint={signIn.signIn?.hint ?? ''}
          kept={signIn.signIn?.text ?? null}
          other={otherAgent ? { id: otherAgent.type, label: otherAgent.label } : null}
          // The agent's own terminal, in a normal pane (the same sign-in the terminal uses).
          onOpen={() => c.newAgent(signIn.agent, undefined, false, c.registry.panes.get(paneId)?.info.cwd, undefined, 'terminal')}
          onRetry={() => api.retrySignIn?.(paneId)}
          onUseOther={async (id, kept) => {
            const opened = await c.newAgent(id, undefined, false, c.registry.panes.get(paneId)?.info.cwd);
            // Nothing is sent: the kept words wait in the new chat's message box for the person to read and send.
            if (opened && kept) pushComposerInsert(opened, kept);
          }}
        />
      )}
      {interrupted && !strip && (
        <div className="ck-acp-strip" data-testid="acp-interrupted">
          <span className="ck-acp-strip-text" role="status">
            {continueError ? `${interrupted.text} ${continueError}` : interrupted.text}
          </span>
          {api.continueTurn && (
            <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={continueTurn} disabled={continuing}>
              {continuing ? 'Sending…' : 'Continue'}
            </button>
          )}
        </div>
      )}
      {stopped && !strip && (
        <ErrorCard
          testId="acp-stopped"
          compact
          who={state?.label ?? paneName}
          what={restartError ? `${stopped.text}. ${restartError}` : stopped.text}
          can={t('flow.error.chatStopped.can')}
          details={state?.exit?.reason ?? null}
          action={api.restart ? { label: restarting ? t('flow.error.chatStopped.restarting') : restartError ? t('flow.error.chatStopped.retry') : t('flow.error.chatStopped.restart'), onClick: restart, disabled: restarting } : undefined}
        />
      )}
      {orphan && waitingNoCard && (
        <div className="ck-acp-strip" data-testid="acp-orphan-wait">
          <span className="ck-acp-strip-text" role="status">
            The agent is waiting but didn't say what for.
          </span>
          <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={stop}>
            Deny and stop
          </button>
        </div>
      )}
      {quiet && (
        <div className="ck-acp-strip" data-testid="acp-quiet">
          <span className="ck-acp-strip-text" role="status">
            {quiet.text}
          </span>
          <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={stop}>
            Stop
          </button>
          {api.keepWaiting && (
            <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={keepWaiting}>
              Keep waiting
            </button>
          )}
        </div>
      )}
      {autoAllow.length > 0 && (
        <div className="ck-dc-auto" data-testid="auto-allow-line">
          <span>Not asking for: {autoAllow.map((k) => kindWords(k) ?? k).join(', ')}</span>
          <span aria-hidden="true"> · </span>
          {autoAllow.map((k) => (
            <button key={k} type="button" className="ck-dc-more" onClick={() => turnBackOn(k)}>
              {autoAllow.length > 1 ? `Turn back on (${kindWords(k) ?? k})` : 'Turn back on'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
