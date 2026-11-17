// One calm conversation on the phone: the agent's text at full width, your messages in a soft bubble, and the tool steps
// folded into one line per turn (one tap opens the list; a failed step is never folded). The dock (what waits on you), the
// queued messages and the composer sit under it. This is the phone's own view: the desktop's chat view stays as it is.
import { PhoneBottomRegion } from './PhoneBottomRegion';
import { Fragment, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { ChatSource, ChatTurn, SessionChatState, TurnStep } from '../../lib/sessionChatModel';
import { ChatMarkdown } from '../chat/ChatMarkdown';
import { PictureSourceContext } from '../chat/ChatPicture';
import { EarlierRow } from '../chat/EarlierRow';
import { useKeepPlace } from '../../hooks/useKeepPlace';
import type { EarlierState } from '../../hooks/useEarlier';
import type { PictureSource } from '../../lib/chatMore';
import { AttachmentChips } from '../chat/AttachmentChips';
import { HelperRow } from '../chat/HelperRow';
import { NoticeLine } from '../chat/NoticeLine';
import { ArtifactCard } from '../artifacts/ArtifactCard';
import { ARTIFACT_NOTICE, type ArtifactRef } from '../../lib/artifacts';
import { PermissionTrace } from '../chat/PermissionTrace';
import { ThinkingBlock } from '../chat/ThinkingBlock';
import { currentPlan } from '../chat/PlanCard';
import { ToolRow } from '../chat/ToolRow';
import { clockOf } from '../../lib/phone-link';
import { JumpToLatest, SinceLine } from '../chat/SinceLine';
import { TurnPriceTag } from '../chat/TurnPriceTag';
import { useUsualNotesOn } from '../../lib/usual-notes';
import { useSinceLine } from '../chat/useSinceLine';
import { hasPrice, turnPrices, type TurnPrice } from '../../lib/turnPrice';
import { FoldedSteps } from './FoldedSteps';
import { PhonePlanLine } from './PhonePlanLine';
import { PhoneQuiet } from './PhoneQuiet';
import { usePhoneTextSize } from '../../lib/phone-text-size';
import { usePacedText } from '../../hooks/usePacedText';
import { Pressable, type PressedMessage } from './MessageActions';
import { MessageRail } from '../chat/MessageRail';
import { buildRailEntries } from '../chat/messageRailModel';
import { foldTurnSteps } from './foldSteps';
import { hideResultBlock } from '../../lib/phone-result';
import '../../styles/phone-shell.css';
import '../../styles/phone-link.css';

/** Within this many pixels of the end counts as "at the bottom" (auto-scroll follows only then). */
const AT_BOTTOM_PX = 24;

/** `paced`: the last agent message of a running turn. Its words come out on a short tick (hooks/usePacedText.ts); anything else shows whole. */
function TextPiece({ step, markdown, paced }: { step: Extract<TurnStep, { kind: 'text' }>; markdown: boolean; paced: boolean }) {
  const text = usePacedText(step.item.text, paced);
  return markdown ? (
    <ChatMarkdown text={hideResultBlock(text)} />
  ) : (
    <div className="ph-conv-plain">{text}</div>
  );
}

function TurnBlock({ turn, fromScreen, markdown, onPress, price, onOpenArtifact, sentFrom }: { sentFrom?: string; onOpenArtifact?: (ref: ArtifactRef, title: string) => void; price?: TurnPrice; turn: ChatTurn; fromScreen: boolean; markdown: boolean; onPress?: (message: PressedMessage) => void }) {
  const t = useT();
  const live = turn.end === null;
  const usualOn = useUsualNotesOn();
  const lastStepId = turn.steps[turn.steps.length - 1]?.id;
  // No "Done · 4 s" under every answer: how long it took is said once, in the header and on the result card.
  const ending = turn.outcome === 'interrupted' ? t('phone.conv.stopped') : turn.outcome === 'failed' ? t('phone.conv.failed') : null;
  return (
    <section className="ph-turn" data-turn-id={turn.id}>
      {turn.user && (
        <div className="ph-you" data-rail-id={turn.user.id}>
          {turn.user.attachments && turn.user.attachments.length > 0 && <AttachmentChips attachments={turn.user.attachments} className="ck-chat-user-files" />}
          {turn.user.text.trim() !== '' && (
            <Pressable className="ph-you-bubble" message={{ text: turn.user.text, mine: true }} onPress={onPress}>
              {turn.user.text}
            </Pressable>
          )}
          {sentFrom && (
            <span className="ph-from" data-testid="phone-sent-from">
              {sentFrom}
            </span>
          )}
        </div>
      )}
      {foldTurnSteps(turn.steps).map((piece) => {
        if (piece.kind === 'fold') return <FoldedSteps key={`fold:${piece.id}`} steps={piece.steps} live={live} fromScreen={fromScreen} />;
        if (piece.kind === 'ask') return <ToolRow key={piece.step.id} step={piece.step} fromScreen={fromScreen} live={live} />;
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
          if (step.item.noticeKind === ARTIFACT_NOTICE && onOpenArtifact) return <ArtifactCard key={step.id} title={step.item.text} url={step.item.url} onOpen={onOpenArtifact} />;
          return step.item.noticeKind === 'permission' ? (
            <PermissionTrace key={step.id} text={step.item.text} />
          ) : (
            <NoticeLine key={step.id} text={step.item.text} kind={step.item.noticeKind} url={step.item.url} />
          );
        }
        if (step.kind === 'thinking') return <ThinkingBlock key={step.id} text={step.item.text} durationMs={step.item.durationMs} streaming={live && step.id === lastStepId} folded />;
        return (
          <Pressable key={step.id} railId={step.id} className="ph-agent-text" message={{ text: step.item.text, mine: false }} onPress={onPress}>
            <TextPiece step={step} markdown={markdown} paced={live && step.id === lastStepId} />
          </Pressable>
        );
      })}
      {turn.end && ending && <p className="ph-turn-end">{ending}</p>}
      {turn.end && hasPrice(price) && price.heavy && usualOn && <TurnPriceTag price={price} />}
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
  chatId,
  onOpenArtifact,
  sentFrom,
  earlier,
  pictures = null,
  hideScreenNote = false,
}: {
  /** "Show earlier messages": a row at the top while the chat has older messages that are not held. */
  earlier?: EarlierState;
  /** Where the pictures the agent names come from (the PC checks every path). Absent: only the words are shown. */
  pictures?: PictureSource | null;
  /** The chat's id (its pane): the moment it was last read is kept under it, for the "New since you looked" line. */
  chatId?: string | null;
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
  /** "from OPPO Reno13" under a message another device sent, by turn id (`sentFromLines`). */
  sentFrom?: ReadonlyMap<string, string>;
  /** A tap on a page card (a page the agent made). Absent: the card is a plain line. */
  onOpenArtifact?: (ref: ArtifactRef, title: string) => void;
  /** Leave out the "read from the screen" line (a companion's chat has no use for it). */
  hideScreenNote?: boolean;
}) {
  const t = useT();
  const fromScreen = source === 'screen';
  // Markdown only for what the agent itself wrote; text read off the terminal is shown as it is.
  const markdown = source === 'file' || source === 'api' || source === 'acp';
  const plan = useMemo(() => currentPlan(turns), [turns]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  usePhoneTextSize(rootRef);
  const atBottom = useRef(true);
  const prices = useMemo(() => turnPrices(turns), [turns]);
  const railEntries = useMemo(() => buildRailEntries(turns, 'normal'), [turns]);
  const sinceLine = useSinceLine({ chatId, turns, ready: state === 'ready', scrollRef, atBottom });

  const noteWhere = useKeepPlace(scrollRef, atBottom, earlier?.version ?? 0);

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
    <PictureSourceContext.Provider value={pictures}>
    <div ref={rootRef} className="ph-conv" data-testid="phone-conversation" data-stale={staleAt !== null ? 'true' : undefined}>
      {fromScreen && !hideScreenNote && state !== 'unavailable' && <p className="ph-conv-note">{t('phone.conv.screenNote')}</p>}
      {staleAt !== null && (
        <p className="ph-asof" data-testid="phone-asof">
          {t('phone.link.asOf', { time: clockOf(staleAt) })}
        </p>
      )}
      {progress}
      <PhonePlanLine items={plan} />
      <div className="ck-mrail-host">
      <div
        ref={scrollRef}
        className="ph-conv-body"
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
          if (atBottom.current) sinceLine.reachedEnd();
        }}
      >
        {state === 'unavailable' && (
          <div className="ph-conv-empty">
            <h2>{t('phone.conv.unavailable')}</h2>
            <p>{reason ?? t('phone.conv.unavailableBody')}</p>
          </div>
        )}
        {state !== 'unavailable' && earlier && <EarlierRow earlier={earlier} onPress={noteWhere} />}
        {state !== 'unavailable' && turns.length === 0 && (
          <div className="ph-conv-empty">
            <PhoneQuiet kind="loading" compact text={fromScreen ? t('phone.conv.waitingScreen') : t('phone.conv.waiting')} />
            {waitingFor && <p className="ph-conv-sub">{waitingFor}</p>}
          </div>
        )}
        {state !== 'unavailable' && turns.map((turn) => (
            <Fragment key={turn.id}>
              {sinceLine.show && sinceLine.report?.firstTurnId === turn.id && <SinceLine report={sinceLine.report} />}
              <TurnBlock turn={turn} fromScreen={fromScreen} markdown={markdown} onPress={onPressMessage} price={prices.get(turn.id)} onOpenArtifact={onOpenArtifact} sentFrom={sentFrom?.get(turn.id)} />
            </Fragment>
          ))}
        {state !== 'unavailable' && after}
        {state !== 'unavailable' && pending}
        {sinceLine.show && <JumpToLatest onJump={sinceLine.jumpToLatest} />}
      </div>
      {state !== 'unavailable' && <MessageRail entries={railEntries} scrollRef={scrollRef} rootRef={rootRef} findQuery="" />}
      </div>
      <PhoneBottomRegion dock={dock} above={above} composer={state !== 'unavailable' ? composer : null} />
    </div>
    </PictureSourceContext.Provider>
  );
}
