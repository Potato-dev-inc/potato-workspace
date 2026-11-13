// One calm conversation on the phone: the agent's text at full width, your messages in a soft bubble, and the tool steps
// folded into one line per turn (one tap opens the list; a failed step is never folded). The dock (what waits on you), the
// queued messages and the composer sit under it. This is the phone's own view: the desktop's chat view stays as it is.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { ChatSource, ChatTurn, SessionChatState, TurnStep } from '../../lib/sessionChatModel';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { AttachmentChips } from '../chat/AttachmentChips';
import { HelperRow } from '../chat/HelperRow';
import { NoticeLine } from '../chat/NoticeLine';
import { PermissionTrace } from '../chat/PermissionTrace';
import { ThinkingBlock } from '../chat/ThinkingBlock';
import { currentPlan } from '../chat/PlanCard';
import { PlanBar } from '../chat/PlanBar';
import { ToolRow } from '../chat/ToolRow';
import { clockOf } from '../../lib/phone-link';
import { FoldedSteps } from './FoldedSteps';
import { Pressable, type PressedMessage } from './MessageActions';
import { foldTurnSteps } from './foldSteps';
import '../../styles/phone-shell.css';
import '../../styles/phone-link.css';

/** Within this many pixels of the end counts as "at the bottom" (auto-scroll follows only then). */
const AT_BOTTOM_PX = 24;

function TextPiece({ step, markdown }: { step: Extract<TurnStep, { kind: 'text' }>; markdown: boolean }) {
  return markdown ? (
    <ChatMarkdown text={step.item.text} />
  ) : (
    <div className="ph-conv-plain">{step.item.text}</div>
  );
}

function TurnBlock({ turn, fromScreen, markdown, onPress }: { turn: ChatTurn; fromScreen: boolean; markdown: boolean; onPress?: (message: PressedMessage) => void }) {
  const t = useT();
  const live = turn.end === null;
  const lastStepId = turn.steps[turn.steps.length - 1]?.id;
  const ending = turn.ending?.text ?? (turn.outcome === 'interrupted' ? t('phone.conv.stopped') : turn.outcome === 'failed' ? t('phone.conv.failed') : null);
  return (
    <section className="ph-turn" data-turn-id={turn.id}>
      {turn.user && (
        <div className="ph-you">
          {turn.user.attachments && turn.user.attachments.length > 0 && <AttachmentChips attachments={turn.user.attachments} className="ck-chat-user-files" />}
          {turn.user.text.trim() !== '' && (
            <Pressable className="ph-you-bubble" message={{ text: turn.user.text, mine: true }} onPress={onPress}>
              {turn.user.text}
            </Pressable>
          )}
        </div>
      )}
      {foldTurnSteps(turn.steps).map((piece) => {
        if (piece.kind === 'fold') return <FoldedSteps key={`fold:${piece.id}`} steps={piece.steps} live={live} fromScreen={fromScreen} />;
        if (piece.kind === 'failed') {
          return (
            <div key={piece.step.id} className="ph-failed" data-testid="phone-failed-step">
              <ToolRow step={piece.step} fromScreen={fromScreen} defaultOpen live={live} />
            </div>
          );
        }
        const step = piece.step;
        if (step.kind === 'tool') return <HelperRow key={step.id} step={step} fromScreen={fromScreen} />;
        if (step.kind === 'notice') {
          return step.item.noticeKind === 'permission' ? (
            <PermissionTrace key={step.id} text={step.item.text} />
          ) : (
            <NoticeLine key={step.id} text={step.item.text} kind={step.item.noticeKind} url={step.item.url} />
          );
        }
        if (step.kind === 'thinking') return <ThinkingBlock key={step.id} text={step.item.text} durationMs={step.item.durationMs} streaming={live && step.id === lastStepId} />;
        return (
          <Pressable key={step.id} className="ph-agent-text" message={{ text: step.item.text, mine: false }} onPress={onPress}>
            <TextPiece step={step} markdown={markdown} />
          </Pressable>
        );
      })}
      {turn.end && ending && <p className="ph-turn-end">{ending}</p>}
    </section>
  );
}

export function PhoneConversation({
  state,
  reason,
  waitingFor,
  source,
  turns,
  dock,
  pending,
  composer,
  above,
  progress,
  after,
  staleAt = null,
  onPressMessage,
}: {
  state: SessionChatState;
  reason: string | null;
  waitingFor?: string | null;
  source?: ChatSource | null;
  turns: ChatTurn[];
  /** What waits on the person (a card), under the conversation. */
  dock?: ReactNode;
  /** The messages you sent that the conversation does not show yet. */
  pending?: ReactNode;
  /** The message box. Without it the conversation is read-only. */
  composer?: ReactNode;
  /** Between the dock and the message box (the queue bar, "Stopped", the "needs you" pill). */
  above?: ReactNode;
  /** The live progress line, under the header, above the conversation. */
  progress?: ReactNode;
  /** After the last turn, inside the scrolling conversation (the result card). */
  after?: ReactNode;
  /** The PC cannot be reached: the time this conversation was last read. It is shown greyed with "as of HH:MM". */
  staleAt?: number | null;
  /** A long press on a message (yours or the agent's). Absent: messages are plain. */
  onPressMessage?: (message: PressedMessage) => void;
}) {
  const t = useT();
  const fromScreen = source === 'screen';
  // Markdown only for what the agent itself wrote; text read off the terminal is shown as it is.
  const markdown = source === 'file' || source === 'api' || source === 'acp';
  const plan = useMemo(() => currentPlan(turns), [turns]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Follow new items only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [turns, pending]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="ph-conv" data-testid="phone-conversation" data-stale={staleAt !== null ? 'true' : undefined}>
      {fromScreen && state !== 'unavailable' && <p className="ph-conv-note">{t('phone.conv.screenNote')}</p>}
      {staleAt !== null && (
        <p className="ph-asof" data-testid="phone-asof">
          {t('phone.link.asOf', { time: clockOf(staleAt) })}
        </p>
      )}
      {progress}
      <PlanBar items={plan} />
      <div
        ref={scrollRef}
        className="ph-conv-body"
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
        }}
      >
        {state === 'unavailable' && (
          <div className="ph-conv-empty">
            <h2>{t('phone.conv.unavailable')}</h2>
            <p>{reason ?? t('phone.conv.unavailableBody')}</p>
          </div>
        )}
        {state !== 'unavailable' && turns.length === 0 && (
          <div className="ph-conv-empty">
            <p>{fromScreen ? t('phone.conv.waitingScreen') : t('phone.conv.waiting')}</p>
            {waitingFor && <p className="ph-conv-sub">{waitingFor}</p>}
          </div>
        )}
        {state !== 'unavailable' && turns.map((turn) => <TurnBlock key={turn.id} turn={turn} fromScreen={fromScreen} markdown={markdown} onPress={onPressMessage} />)}
        {state !== 'unavailable' && after}
        {state !== 'unavailable' && pending}
      </div>
      {dock && <div className="ph-conv-dock">{dock}</div>}
      {above}
      {state !== 'unavailable' && composer}
    </div>
  );
}
