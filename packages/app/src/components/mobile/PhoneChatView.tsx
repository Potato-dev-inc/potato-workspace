// The chat of one agent pane on the phone: the same view the desktop has (SessionChatView), fed by
// `GET /panes/{id}/chat?since=<rev>` every 1.5 s while this view and the page are visible. Each answer carries
// only what changed since the last one; `reset` drops the list held. It never touches the pane's size (the
// terminal under it keeps its own lease rules). The message box at the bottom sends through the PC's bridge
// (`paneOutbox-bridge.ts`) and needs the `type` cap; without it the box is replaced by one plain line.
// Phone part 2 adds: the last chat stays readable (greyed, "as of HH:MM") when the PC cannot be reached, messages typed then wait
// and ask before they are sent, Send turns into Stop while the agent works ("Stopped · Continue" for 10 s after), and an agent the
// PC's remote rule keeps this phone out of shows one sentence and "Ask the PC for control" instead of the box.
import { errorSentence } from '../../lib/sayError';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t as translate, useT } from '../../i18n';
import type { BridgeClient } from '../../lib/bridge-types';
import { bridgeOutboxTransport } from '../../lib/paneOutbox-bridge';
import { groupTurns, mergeItems, type ChatItem, type ChatSource, type SessionChatState } from '../../lib/sessionChatModel';
import { usePaneOutbox } from '../../hooks/usePaneOutbox';
import { usePendingBubbles } from '../../hooks/usePendingBubbles';
import { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { canReach, type LinkKind } from '../../lib/phone-link';
import { readChatCache, writeChatCache } from '../../lib/phone-chat-cache';
import type { RuleLimit } from '../../lib/pane-rule-view';
import { PendingMessages } from '../chat/PendingMessages';
import { PhoneComposer } from './PhoneComposer';
import { PhoneConversation } from './PhoneConversation';
import { PhoneNoControl } from './PhoneNoControl';
import { PhoneQueueBar } from './PhoneQueueBar';
import { PhoneStoppedBar } from './PhoneStoppedBar';
import '../../styles/phone-chat.css';

/** How often the PC is asked while the chat is on screen. */
export const POLL_MS = 1500;
/** Items kept in the list; the oldest go first. The PC sends at most 300 at once. */
const MAX_KEPT = 1500;

// The notes are read when they are shown, so they follow the phone's language.
export const NO_WATCH_NOTE = 'This phone cannot read chats.';
export const NO_SEND_NOTE = 'This phone cannot send messages.';

interface Status {
  state: SessionChatState;
  reason: string | null;
  waitingFor: string | null;
  source: ChatSource | null;
}

const LOADING: Status = { state: 'loading', reason: null, waitingFor: null, source: null };

function sameStatus(a: Status, b: Status): boolean {
  return a.state === b.state && a.reason === b.reason && a.waitingFor === b.waitingFor && a.source === b.source;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/** The PC refused this phone (no `watch`) or the pane is gone: asking again changes nothing. */
function refusalOf(error: unknown): string | null {
  const text = errorSentence(error);
  if (/ -> 403/.test(text)) return translate('phone.conv.noWatch');
  if (/ -> 404/.test(text)) return translate('phone.conv.gone');
  return null;
}

export function PhoneChatView({
  bridge,
  paneId,
  canWatch,
  canType,
  sendBlock = null,
  dock,
  above,
  link = 'connected',
  working = false,
  ruleLimit = null,
}: {
  bridge: BridgeClient | null;
  paneId: string;
  /** This phone may read pane text (`watch`). Without it nothing is asked. */
  canWatch: boolean;
  /** This phone may send messages to the agent (`type`). Without it the box is replaced by one line. */
  canType: boolean;
  /** Why the message box is switched off (shown instead of a hint), or null. */
  sendBlock?: string | null;
  /** What waits on the person (the docked card), under the conversation. */
  dock?: ReactNode;
  /** Between the dock and the message box: the "needs you" pill. */
  above?: ReactNode;
  /** How the phone is connected. Anything but `connected` greys the chat and keeps new messages on the phone. */
  link?: LinkKind;
  /** The agent is working now (Send is Stop while nothing is typed). */
  working?: boolean;
  /** The PC's remote rule for this agent keeps this phone from typing (`off` and `watch` and `answer`), or null. */
  ruleLimit?: RuleLimit | null;
}) {
  const cached = useMemo(() => readChatCache(paneId), [paneId]);
  const [items, setItems] = useState<ChatItem[]>(cached?.items ?? []);
  const [status, setStatus] = useState<Status>(LOADING);
  /** When the list on screen was last read from the PC. */
  const [readAt, setReadAt] = useState<number | null>(cached?.at ?? null);
  const visible = usePageVisible();
  const reach = canReach(link);
  /** The newest revision seen: the next question is "what changed since this". */
  const revRef = useRef<number | undefined>(undefined);
  const heldRef = useRef(items.length);
  heldRef.current = items.length;
  const paneRef = useRef(paneId);
  if (paneRef.current !== paneId) {
    paneRef.current = paneId;
    revRef.current = undefined;
  }

  // A different pane starts from nothing (or from what the phone kept of it).
  useEffect(() => {
    const kept = readChatCache(paneId);
    setItems(kept?.items ?? []);
    setReadAt(kept?.at ?? null);
    setStatus(LOADING);
  }, [paneId]);

  useEffect(() => {
    if (!bridge?.paneChat || !canWatch || !visible) return;
    let live = true;
    let timer = 0;
    const ask = bridge.paneChat.bind(bridge);

    const show = (next: Status) => setStatus((prev) => (sameStatus(prev, next) ? prev : next));

    const tick = async () => {
      let again = true;
      try {
        const reply = await ask(paneId, revRef.current);
        if (!live) return;
        setReadAt(Date.now());
        if (!reply.available) {
          revRef.current = undefined;
          setItems((prev) => (prev.length === 0 ? prev : []));
          show({ state: 'unavailable', reason: reply.reason, waitingFor: null, source: null });
        } else {
          revRef.current = reply.rev;
          if (reply.reset || reply.items.length > 0) {
            setItems((prev) => mergeItems(prev, reply.items, reply.reset).slice(-MAX_KEPT));
          }
          show({ state: 'ready', reason: null, waitingFor: reply.waitingFor ?? null, source: reply.source ?? 'file' });
        }
      } catch (error) {
        if (!live) return;
        const refused = refusalOf(error);
        if (refused) {
          again = false;
          show({ state: 'unavailable', reason: refused, waitingFor: null, source: null });
        } else if (revRef.current === undefined) {
          // Never loaded this visit: the chat the phone kept is shown, else one plain sentence.
          if (heldRef.current > 0) show({ state: 'ready', reason: null, waitingFor: null, source: 'file' });
          else show({ state: 'unavailable', reason: translate('phone.conv.unreachable'), waitingFor: null, source: null });
        }
      }
      if (live && again) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [bridge, paneId, canWatch, visible]);

  // What was read is kept on the phone, so the last chat is still there when the PC is not.
  useEffect(() => {
    if (!reach || items.length === 0) return;
    const timer = window.setTimeout(() => writeChatCache(paneId, items, readAt ?? Date.now()), 2000);
    return () => window.clearTimeout(timer);
  }, [paneId, items, readAt, reach]);

  const grouped = useMemo(() => groupTurns(items), [items]);

  // The message box: its messages come over the bridge, and it needs to read the list (`watch`) as well as send.
  const canSend = canWatch && canType && ruleLimit === null;
  const outboxTransport = useMemo(() => (bridge ? bridgeOutboxTransport(bridge) : null), [bridge]);
  const outbox = usePaneOutbox(outboxTransport, paneId, canSend);
  const userTexts = useMemo(() => grouped.turns.flatMap((turn) => (turn.user ? [turn.user.text] : [])), [grouped.turns]);
  const { bubbles, hide } = usePendingBubbles(outbox.messages, userTexts);
  const pending = canSend ? <PendingMessages messages={bubbles} onCancel={outbox.cancel} onHide={hide} /> : undefined;
  const t = useT();

  // Typed while the PC cannot be reached: kept on the phone, asked about when the PC is back.
  const queue = useOfflineQueue(paneId, t('phone.queue.full'));
  const sendOrKeep = useCallback((text: string) => (reach ? outbox.send(text) : Promise.resolve(queue.add(text))), [reach, outbox, queue]);

  // Stop: the turn is interrupted on the PC. "Stopped · Continue" stays 10 seconds.
  const [stoppedBar, setStoppedBar] = useState(false);
  useEffect(() => setStoppedBar(false), [paneId]);
  const onStop = useMemo(() => {
    if (!bridge?.interruptPane || !reach) return undefined;
    return async () => {
      try {
        await bridge.interruptPane!(paneId);
        setStoppedBar(true);
        return null;
      } catch (error) {
        return / -> 403/.test(errorSentence(error)) ? t('phone.stop.refused') : errorSentence(error, t('phone.stop.failed'));
      }
    };
  }, [bridge, paneId, reach, t]);
  const goneBar = useCallback(() => setStoppedBar(false), []);

  const askControl = useCallback(() => (bridge?.askControl ? bridge.askControl(paneId) : Promise.reject(new Error('no route -> 404'))), [bridge, paneId]);

  const composer = ruleLimit !== null ? (
    <PhoneNoControl limit={ruleLimit} onAsk={askControl} />
  ) : canSend ? (
    <PhoneComposer key={paneId} onSend={sendOrKeep} blockedReason={sendBlock} draftKey={paneId} model={grouped.model} working={working} onStop={onStop} />
  ) : (
    <p className="ph-chat-send-off" data-testid="phone-chat-no-send">{t('phone.conv.noSend')}</p>
  );
  const bars = (
    <>
      {stoppedBar && <PhoneStoppedBar onContinue={() => outbox.send(t('phone.stopped.continueText'))} onGone={goneBar} />}
      <PhoneQueueBar waiting={queue.waiting} reachable={reach} onSend={() => queue.sendAll((text) => outbox.send(text))} onDiscard={queue.discard} />
      {above}
    </>
  );

  if (!canWatch) {
    return (
      <div className="ph-chat" data-testid="phone-chat">
        <p className="ph-chat-plain">{t('phone.conv.noWatch')}</p>
        {dock}
        {ruleLimit !== null ? composer : !canType && <p className="ph-chat-send-off" data-testid="phone-chat-no-send">{t('phone.conv.noSend')}</p>}
      </div>
    );
  }
  return (
    <div className="ph-chat" data-testid="phone-chat">
      <PhoneConversation
        state={status.state}
        reason={status.reason}
        waitingFor={status.waitingFor}
        source={status.source}
        turns={grouped.turns}
        dock={dock}
        pending={pending}
        above={bars}
        composer={composer}
        staleAt={!reach && readAt !== null && grouped.turns.length > 0 ? readAt : null}
      />
    </div>
  );
}
