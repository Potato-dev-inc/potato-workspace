// What a chat session over ACP adds under its conversation: the agent's permission questions as cards (the Inbox's own
// decision card, with the agent's real options), and a strip that says what the session is doing with
// a Stop button that reads "Stopping…" until the agent has ended the turn. While a question is open it also holds the
// small switch that lets an agent answer these questions (off by default).
import { useEffect, useState } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { errorSentence, interruptedStrip, permissionCards, quietStrip, runStrip, stoppedStrip, tauriAcpChatApi, type AcpChatApi } from '../../lib/acpChat';
import { kindWords, permissionOf } from '../../lib/decisionCard';
import { DecisionCard, type DecisionAnswer } from './DecisionCard';
import { AgentAnsweringSwitch } from './AgentAnsweringSwitch';
import { SignInCard } from '../acp/SignInCard';
import '../../styles/cockpit-acp.css';

export function AcpChatDock({ c, paneId, paneName, api = tauriAcpChatApi }: { c: CockpitApi; paneId: string; paneName: string; api?: AcpChatApi }) {
  const state = useAcpChatState(paneId, true, api);
  // The person pressed Stop: the strip reads "Stopping…" at once, before the backend's state event comes back.
  const [asked, setAsked] = useState(false);
  const running = !!state?.turnInFlight;
  useEffect(() => {
    if (!running) setAsked(false);
  }, [running]);
  useEffect(() => setAsked(false), [paneId]);

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
  const quiet = quietStrip(state, asked);
  const strip = quiet ? null : runStrip(state, asked);
  const signIn = state && !state.closed && state.signIn?.needed ? state : null;
  if (cards.length === 0 && !strip && !quiet && !signIn && !stopped && !interrupted && autoAllow.length === 0) return null;
  const keepWaiting = () => {
    api.keepWaiting?.(paneId).catch(() => undefined);
  };
  const stop = () => {
    setAsked(true);
    api.cancel(paneId).catch(() => setAsked(false));
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
        <SignInCard
          label={signIn.label}
          hint={signIn.signIn?.hint ?? ''}
          // The agent's own terminal, in a normal pane (the same sign-in the terminal uses).
          onOpen={() => c.newAgent(signIn.agent, undefined, false, c.registry.panes.get(paneId)?.info.cwd)}
          onRetry={() => api.retrySignIn?.(paneId)}
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
        <div className="ck-acp-strip" data-testid="acp-stopped">
          <span className="ck-acp-strip-text" role="status">
            {restartError ? `${stopped.text}. ${restartError}` : stopped.text}
          </span>
          {api.restart && (
            <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={restart} disabled={restarting}>
              {restarting ? 'Restarting…' : restartError ? 'Retry' : 'Restart chat'}
            </button>
          )}
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
      {strip && (
        <div className="ck-acp-strip" data-testid="acp-strip" data-stopping={strip.stopping ? '' : undefined}>
          <span className="ck-acp-strip-text" role="status">
            {strip.text}
          </span>
          <button type="button" className="ck-btn ck-btn--secondary ck-acp-stop" onClick={stop} disabled={strip.stopping}>
            {strip.stopping ? 'Stopping…' : 'Stop'}
          </button>
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
