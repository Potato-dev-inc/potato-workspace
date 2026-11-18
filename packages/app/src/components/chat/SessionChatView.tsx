// Read-only chat of a terminal pane's agent session: the person's messages, the agent's text, and each turn's tool
// calls folded into one activity line (click to open the rows and their detail). A pinned task card sits at the top
// when the agent has a plan, a thin line marks a notice, and a turn ends with how long it worked. The view mode
// (Summary, Normal, Verbose) is in the header. The agent's text is Markdown when it comes from the session file;
// text read off the terminal is shown as it is.
import { loadDesktopDeviceNames } from '../../lib/deviceNames.desktop';
import { t } from '../../i18n';
import { sentFromLines, useDeviceNames } from '../../lib/deviceNames';
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { clearChatJump, turnWithItem, type ChatJump } from '../../lib/chatJump';
import { registerPaneTurns } from '../../lib/potatoCheck';
import type { ChatSource, ChatTurn, SessionChatState, TurnStep } from '../../lib/sessionChatModel';
import '../../styles/cockpit-chat.css';
import { ActivityLine } from './ActivityLine';
import { AttachmentChips } from './AttachmentChips';
import { segmentSteps } from './chatActivity';
import { formatDuration } from './chatFormat';
import { useChatViewMode, type ChatViewMode } from './chatViewMode';
import { hideResultBlock } from '../../lib/phone-result';
import { ChatMarkdown } from './ChatMarkdown';
import { PictureSourceContext } from './ChatPicture';
import { EarlierRow } from './EarlierRow';
import { useKeepPlace } from '../../hooks/useKeepPlace';
import { desktopPictureSource, type PictureSource } from '../../lib/chatMore';
import type { EarlierState } from '../../hooks/useEarlier';
import { HelperRow } from './HelperRow';
import { MarkupCard, WorkflowCard } from './WorkflowCard';
import { splitMarkupMessage, type MarkupSplit } from '../../lib/markupCard';
import { useMarkupSends } from '../../hooks/useMarkupSends';
import { readWorkflowStart, splitWorkflowMessage, type WorkflowSplit } from '../../lib/workflowCard';
import { PaneHelperRows } from './PaneHelperRows';
import { placeHelpers, type ChatHelper } from '../../lib/chat-helpers';
import { NoticeLine } from './NoticeLine';
import { ArtifactCard } from '../artifacts/ArtifactCard';
import { ARTIFACT_NOTICE } from '../../lib/artifacts';
import { openArtifactBeside } from '../../lib/artifact-side';
import { PermissionTrace } from './PermissionTrace';
import { ResponseActions } from './ResponseActions';
import { ThinkingBlock } from './ThinkingBlock';
import { RememberSelection } from './RememberSelection';
import { currentPlan } from './PlanCard';
import { PlanBar } from './PlanBar';
import { planProgress, publishPlanProgress } from '../../lib/planProgress';
import { ToolRow } from './ToolRow';
import { ChatFindContext } from './chatFind';
import { ChatFindBar } from './ChatFindBar';
import { isFindKey, useChatFind } from './useChatFind';
import { JumpToLatest, SinceLine } from './SinceLine';
import { TurnPriceTag } from './TurnPriceTag';
import { useSinceLine } from './useSinceLine';
import { hasPrice, turnPrices, type TurnPrice } from '../../lib/turnPrice';
import { TurnEndingButtons, type EndingActions } from './TurnEndingButtons';
import { ViewModeToggle } from './ViewModeToggle';
import { MessageRail } from './MessageRail';
import { buildRailEntries } from './messageRailModel';

export { formatDuration };

/** Under the note when the chat is read off the terminal's text: a reading, not the agent's own record. */
export const SCREEN_CHAT_NOTE = 'Read from the screen: text may be cut or wrapped.';

/** Within this many pixels of the end counts as "at the bottom" (auto-scroll follows only then). */
const AT_BOTTOM_PX = 24;

export interface SessionChatViewProps {
  state: SessionChatState;
  reason: string | null;
  /** What an empty chat is waiting for, under the waiting line (where the reader looks). */
  waitingFor?: string | null;
  /** An ACP chat whose agent is up and idle and has not been asked anything yet: the empty view says it is ready (not "waiting"). */
  ready?: boolean;
  /** Where the items are read from. `screen`: the terminal's text (no tool output; text may be cut or wrapped). */
  source?: ChatSource | null;
  turns: ChatTurn[];
  model: string | null;
  cliVersion: string | null;
  /** What waits on the person (a question card, a bar): shown under the conversation, outside its scroll. */
  dock?: ReactNode;
  /** Another row under the dock, outside it (a card that brings its own dock when it has something to say). */
  aside?: ReactNode;
  /** Messages the person wrote that the conversation does not show yet: bubbles at the end of the conversation. */
  pending?: ReactNode;
  /** The message box, under the dock. Without it the chat is read-only. */
  composer?: ReactNode;
  /** The pane the chat belongs to: its view mode is remembered under it. Without one the mode is Normal and not kept. */
  paneId?: string | null;
  /** Offer "Remember for all agents" on selected text (desktop Chat tab only). Needs `paneId`. */
  remember?: boolean;
  /** Shown at the top of the chat while it has no turns yet (a companion's "new session" line). */
  emptyNote?: ReactNode;
  /** A control next to the view mode switch in the header (the side question button). */
  headerExtra?: ReactNode;
  /** The chat menu at the end of the header (Save as page). */
  headerMenu?: ReactNode;
  /** A place in the pane's own header (PaneView). When given, the view switch, the side question button and the chat menu are drawn there and this chat has no header row of its own. `compact`: the header is tight, so the view switch is one pill. */
  headerSlot?: { el: HTMLElement; compact: boolean };
  /** No Summary/Normal/Verbose switch: the chat is always drawn in full (a chat on another PC, whose far side keeps no such choice). */
  hideViewMode?: boolean;
  /** A one-line note above the conversation (the Keep going line); it shows nothing when there is nothing to say. */
  banner?: ReactNode;
  /** Something laid over the chat, inside it (the side question box). */
  overlay?: ReactNode;
  /** A search result asked for this message: the chat scrolls to it once it is there. */
  jump?: ChatJump | null;
  /** An old chat with no live pane behind it: the "Messages wait…" note would be wrong there, so it is left out. */
  readOnly?: boolean;
  /** Show `Branch` on finished turns (desktop Chat tab only). Needs `onBranch`. Never shown when `readOnly`. */
  canBranch?: boolean;
  /** `Branch` was pressed on the turn that the message with this id starts. */
  onBranch?: (userItemId: string) => void;
  /** The helpers this pane's agent started through Potato Workspace: compact rows in the turn they were started in. */
  helpers?: readonly ChatHelper[];
  /** A helper row was pressed: open that pane. */
  onOpenPane?: (paneId: string) => void;
  /** What the buttons on the newest turn's ending line do (Retry, Sign in, Keep going). Without it the line has no buttons. */
  endings?: EndingActions;
  /** "Show earlier messages": a row at the top while the chat has older messages that are not held. The view keeps its place when they arrive. */
  earlier?: EarlierState;
  /** Where the pictures come from when this chat is not on this PC (another PC's chat names its own files). Without it, this PC's own pane is asked. */
  pictures?: PictureSource | null;
}

/** The `Branch` button on a finished turn's end line. `always`: shown without hover (the newest finished turn). */
interface TurnBranch {
  onBranch: () => void;
  always: boolean;
}

/** A finished turn that a message started: the only kind a branch can start from. */
export function isBranchable(turn: ChatTurn): turn is ChatTurn & { user: NonNullable<ChatTurn['user']> } {
  return turn.end !== null && turn.user !== null;
}

/** The id of the newest branchable turn, or null. */
export function lastBranchableId(turns: readonly ChatTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) if (isBranchable(turns[i])) return turns[i].id;
  return null;
}

/** How long a jump waits for its message to load before it is dropped. */
const JUMP_WAIT_MS = 10_000;

const SUMMARY_NOTE = 'Summary: your messages, final answers and activity lines.';

const TextStep = memo(function TextStep({ step, markdown, mode, actions }: { step: Extract<TurnStep, { kind: 'text' }>; markdown: boolean; mode: ChatViewMode; actions?: { onRetry?: () => Promise<string | null> } }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Summary keeps only the agent's final answers; the rest of its talk is folded away with the rows.
  if (mode === 'summary' && !step.item.finalAnswer) return null;
  // A `potato-result` block (an older prompt, or another agent) is data for the tools, not for the person: hidden.
  const text = hideResultBlock(step.item.text);
  if (text.trim() === '' && step.item.text.trim() !== '') return null;
  const body = markdown ? <ChatMarkdown text={text} /> : <div className="whitespace-pre-wrap break-words ck-chat-text">{text}</div>;
  // `data-rail-id`: the message rail jumps to this reply by it.
  if (!actions) return <div data-rail-id={step.id}>{body}</div>;
  // A finished reply: its text, and under it the quiet row (Copy, and Retry on the newest turn).
  return (
    <div className="ck-msg" data-rail-id={step.id}>
      <div ref={bodyRef}>{body}</div>
      <ResponseActions text={text} targetRef={bodyRef} onRetry={actions.onRetry} />
    </div>
  );
});

function TurnEndDivider({ turn, branch, endings }: { turn: ChatTurn; branch?: TurnBranch; endings?: EndingActions }) {
  const parts: string[] = [];
  if (turn.outcome === 'interrupted' || turn.outcome === 'failed') parts.push(turn.outcome);
  if (turn.durationMs !== null) parts.push(`Worked for ${formatDuration(turn.durationMs)}`);
  const ending = turn.ending;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[10px] text-pm-muted ck-chat-end" data-ending={ending?.reason}>
      <span className="h-px flex-1 bg-pm-border ck-chat-rule" />
      {/* A chat that says how its turns ended has one line for it; the others keep "Worked for". */}
      {ending ? (
        <span className="ck-chat-end-text ck-chat-ending" data-testid="turn-ending">
          {ending.text}
          {endings && <TurnEndingButtons ending={ending} actions={endings} />}
        </span>
      ) : (
        parts.length > 0 && <span className="ck-chat-end-text">{parts.join(' · ')}</span>
      )}
      <span className="h-px flex-1 bg-pm-border ck-chat-rule" />
      {branch && (
        <button type="button" className={`ck-chat-branch-btn${branch.always ? ' is-always' : ''}`} onClick={branch.onBranch}>
          Branch
        </button>
      )}
    </div>
  );
}

/** Test hook: how many times a turn was drawn (a long chat must not redraw every turn for one streamed chunk). */
export const turnRenders = { count: 0 };

/** Everything here is stable for a turn that did not change (see `groupTurns` and `useStable`), so `memo` can skip it. */
/** A message the app wrote for the person, folded into one card: the workflow brief, or a mark-up from the agent browser. */
export type CardView = { kind: 'workflow'; split: WorkflowSplit } | { kind: 'markup'; split: MarkupSplit };
const cardRequest = (c: CardView): string => (c.kind === 'workflow' ? c.split.request : c.split.comment);

const TurnView = memo(function TurnView({ turn, fromScreen, markdown, mode, canBranch, branchAlways, onBranch, helpers, onOpenPane, endings, price, paneId, sentFrom, card }: { card?: CardView | null; sentFrom?: string; paneId?: string; price?: TurnPrice; turn: ChatTurn; fromScreen: boolean; markdown: boolean; mode: ChatViewMode; canBranch: boolean; branchAlways: boolean; onBranch?: (userItemId: string) => void; helpers?: readonly ChatHelper[]; onOpenPane?: (paneId: string) => void; endings?: EndingActions }) {
  turnRenders.count += 1;
  const branch = useMemo<TurnBranch | undefined>(
    () => (canBranch && onBranch && isBranchable(turn) ? { onBranch: () => onBranch(turn.user.id), always: branchAlways } : undefined),
    [canBranch, onBranch, turn, branchAlways],
  );
  const verbose = mode === 'verbose';
  // A turn with no end yet is still running: its rows without a result are live.
  const live = turn.end === null;
  // What is last in the turn is still being written while the turn runs; everything before it is finished.
  const lastStepId = turn.steps[turn.steps.length - 1]?.id;
  let lastTextId: string | null = null;
  for (const s of turn.steps) if (s.kind === 'text') lastTextId = s.id;
  return (
    <section className={`space-y-1.5 ck-chat-turn${live ? '' : ' is-done'}`} data-turn-id={turn.id}>
      {turn.user && (
        <div className="flex flex-col items-end gap-1.5" data-rail-id={turn.user.id}>
          {turn.user.attachments && turn.user.attachments.length > 0 && <AttachmentChips attachments={turn.user.attachments} className="ck-chat-user-files" />}
          {card?.kind === 'workflow' && <WorkflowCard split={card.split} />}
          {card?.kind === 'markup' && <MarkupCard split={card.split} />}
          {(card ? cardRequest(card) : turn.user.text).trim() !== '' && (
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded bg-pm-raised px-2 py-1 text-pm-text ck-chat-bubble">
              {card ? cardRequest(card) : turn.user.text}
            </div>
          )}
          {sentFrom && (
            <span className="ck-chat-from" data-testid="sent-from">
              {sentFrom}
            </span>
          )}
        </div>
      )}
      {segmentSteps(turn.steps).map((segment) => {
        if (segment.kind === 'activity') {
          return <ActivityLine key={segment.id} steps={segment.steps} live={live} fromScreen={fromScreen} verbose={verbose} />;
        }
        const step = segment.step;
        if (step.kind === 'tool') {
          return step.call.helper ? (
            <HelperRow key={step.id} step={step} fromScreen={fromScreen} defaultOpen={verbose} />
          ) : (
            <ToolRow key={step.id} step={step} fromScreen={fromScreen} defaultOpen={verbose} />
          );
        }
        if (step.kind === 'notice') {
          // A page the agent made is a card whatever the view mode: it is the answer, not chatter.
          if (step.item.noticeKind === ARTIFACT_NOTICE && paneId) return <ArtifactCard key={step.id} title={step.item.text} url={step.item.url} onOpen={(ref, title) => openArtifactBeside(ref.id, paneId, title)} />;
          if (mode === 'summary') return null;
          if (step.item.noticeKind === 'permission') return <PermissionTrace key={step.id} text={step.item.text} />;
          return <NoticeLine key={step.id} text={step.item.text} kind={step.item.noticeKind} url={step.item.url} />;
        }
        if (step.kind === 'thinking') {
          return mode === 'summary' ? null : <ThinkingBlock key={step.id} text={step.item.text} durationMs={step.item.durationMs} streaming={live && step.id === lastStepId} />;
        }
        const finished = !fromScreen && (!live || step.id !== lastStepId);
        const retry = endings?.onRetry && turn.end && step.id === lastTextId ? { onRetry: endings.onRetry } : {};
        return <TextStep key={step.id} step={step} markdown={markdown} mode={mode} actions={finished ? retry : undefined} />;
      })}
      {helpers && helpers.length > 0 && <PaneHelperRows helpers={helpers} onOpen={onOpenPane} />}
      {turn.end && <TurnEndDivider turn={turn} branch={branch} endings={endings} />}
      {turn.end && hasPrice(price) && <TurnPriceTag price={price} />}
    </section>
  );
});

/** The value of `next` for each key, but the earlier object where it holds the same data: keeps a memoised row from redrawing. */
function useStable<T>(next: Map<string, T>): Map<string, T> {
  const last = useRef(new Map<string, T>());
  const out = new Map<string, T>();
  for (const [key, value] of next) {
    const was = last.current.get(key);
    out.set(key, was !== undefined && (was === value || JSON.stringify(was) === JSON.stringify(value)) ? was : value);
  }
  last.current = out;
  return out;
}

export function SessionChatView({ state, reason, waitingFor, ready, source, turns, model, cliVersion, dock, pending, composer, paneId, remember, emptyNote, headerExtra, headerMenu, headerSlot, banner, overlay, aside, jump, readOnly, canBranch, onBranch, helpers, onOpenPane, endings, earlier, pictures: farPictures, hideViewMode }: SessionChatViewProps) {
  const fromScreen = source === 'screen';
  // "from OPPO Reno13" under a message that another device sent (names come from the PC's one device record).
  const deviceNames = useDeviceNames(loadDesktopDeviceNames);
  const sentFrom = useMemo(() => sentFromLines(turns, deviceNames), [turns, deviceNames]);
  // Markdown only for what the agent itself wrote (its session file or its API); an unknown source keeps the text as it is.
  const markdown = source === 'file' || source === 'api' || source === 'acp';
  const [chosenMode, setMode] = useChatViewMode(paneId);
  const mode: ChatViewMode = hideViewMode ? 'normal' : chosenMode;
  // Potato ("check on this") reads this chat's turns while it is open, and only reads them.
  const turnsNow = useRef(turns);
  turnsNow.current = turns;
  useEffect(() => (paneId ? registerPaneTurns(paneId, () => turnsNow.current) : undefined), [paneId]);
  const plan = useMemo(() => currentPlan(turns), [turns]);
  // The sidebar and the board draw a thin line from the same list.
  useEffect(() => {
    if (paneId) publishPlanProgress(paneId, planProgress(plan));
  }, [paneId, plan]);
  // The same rule for `Branch`.
  const showBranch = !!canBranch && !!onBranch && !readOnly;
  const newestBranchable = useMemo(() => (showBranch ? lastBranchableId(turns) : null), [showBranch, turns]);
  const placedHelpers = useStable(useMemo(() => placeHelpers(turns, helpers ?? []), [turns, helpers]));
  // The first message of a chat the app started from a workflow is shown as one card (see lib/workflowCard.ts).
  const firstUser = useMemo(() => turns.find((x) => x.user)?.user ?? null, [turns]);
  const workflowCard = useMemo(
    () => (firstUser && paneId ? splitWorkflowMessage(firstUser.text, readWorkflowStart(paneId)) : null),
    [firstUser?.id, firstUser?.text, paneId],
  );
  // A mark-up the app sent from the agent browser is folded the same way, in any turn, when it equals a message the app recorded.
  const markupSends = useMarkupSends(paneId);
  const cards = useMemo(() => {
    const out = new Map<string, CardView>();
    if (workflowCard && firstUser) out.set(firstUser.id, { kind: 'workflow', split: workflowCard });
    if (markupSends.length > 0) {
      for (const turn of turns) {
        if (!turn.user || out.has(turn.user.id)) continue;
        const split = splitMarkupMessage(turn.user.text, markupSends);
        if (split) out.set(turn.user.id, { kind: 'markup', split });
      }
    }
    return out;
  }, [turns, workflowCard, firstUser?.id, markupSends]);
  // The newest callbacks, behind functions that stay the same, so a turn that did not change is not redrawn for them.
  const callbacks = useRef({ onBranch, onOpenPane });
  callbacks.current = { onBranch, onOpenPane };
  const stableBranch = useCallback((id: string) => callbacks.current.onBranch?.(id), []);
  const stableOpenPane = useCallback((id: string) => callbacks.current.onOpenPane?.(id), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // True while the reader is above the end: the `Jump to latest` button shows.
  const [away, setAway] = useState(false);
  const prices = useStable(useMemo(() => turnPrices(turns), [turns]));
  // The message rail beside the scroll bar: one dash per message. Its own list; nothing here reaches a TurnView.
  const railEntries = useMemo(() => buildRailEntries(turns, mode, cards.size > 0 ? new Map([...cards].map(([id, c]) => [id, c.kind === 'workflow' ? c.split.request || c.split.name : c.split.comment || c.split.page])) : undefined), [turns, mode, cards]);

  // Find in this chat (Ctrl+F): the box, the marks and the count. Esc goes back to the message box.
  const find = useChatFind(scrollRef, () => rootRef.current?.querySelector<HTMLTextAreaElement>('textarea.ck-chat-composer-field')?.focus());
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isFindKey(event) || state === 'unavailable') return;
    event.preventDefault();
    event.stopPropagation();
    find.show();
  };

  // "New since you looked": the line above what is new, and the button at the bottom (useSinceLine).
  const sinceLine = useSinceLine({ chatId: paneId, turns, ready: state === 'ready', scrollRef, atBottom });

  // Pictures the agent names are asked of the PC for this pane (it only reads files inside the chat's folder).
  const ownPictures = useMemo(() => (paneId && !readOnly && farPictures === undefined ? desktopPictureSource(paneId) : null), [paneId, readOnly, farPictures]);
  const pictures = farPictures !== undefined ? farPictures : ownPictures;

  // "Show earlier": older messages go in front, and the reader keeps the same message under the same place.
  const noteWhere = useKeepPlace(scrollRef, atBottom, earlier?.version ?? 0);

  // Pinned to the end: a reader at the end follows whatever arrives after (history, streamed text, a picture or a code
  // block that changes height later). A reader scrolled up keeps the place, and `Jump to latest` shows.
  const pinToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, []);
  // Another pane opens at its latest message, whatever place the last reader of this view was at.
  useLayoutEffect(() => {
    atBottom.current = true;
    setAway(false);
  }, [paneId]);
  useLayoutEffect(() => {
    pinToEnd();
  }, [turns, pending, state, mode, pinToEnd]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Any change inside the conversation (history rows, a streamed chunk, a code block that gets its colours later).
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(pinToEnd);
    mutations?.observe(el, { childList: true, subtree: true, characterData: true });
    // A picture changes the height without changing the DOM: its load event is caught on the way down.
    el.addEventListener('load', pinToEnd, true);
    // A docked card takes height from the conversation when it appears or goes: a reader at the end stays at the end;
    // a reader scrolled up keeps the same place.
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(pinToEnd);
    resizes?.observe(el);
    return () => {
      mutations?.disconnect();
      el.removeEventListener('load', pinToEnd, true);
      resizes?.disconnect();
    };
  }, [pinToEnd]);

  // Scroll to the message a search result opened and wash it for a moment. A message that never comes (the chat
  // does not hold it any more) is dropped after a while, and so is one that is not in a chat that has loaded.
  useEffect(() => {
    if (!jump) return;
    const turn = turnWithItem(turns, jump.itemId);
    const el = turn ? [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-turn-id]') ?? [])].find((node) => node.dataset.turnId === turn.id) : undefined;
    if (el) {
      atBottom.current = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('is-found');
      setTimeout(() => el.classList.remove('is-found'), 2000);
      clearChatJump(jump);
      return;
    }
    if (state === 'unavailable') {
      clearChatJump(jump);
      return;
    }
    const giveUp = setTimeout(() => clearChatJump(jump), JUMP_WAIT_MS);
    return () => clearTimeout(giveUp);
  }, [jump, turns, state]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
    setAway(!atBottom.current);
    if (atBottom.current) sinceLine.reachedEnd();
  };
  const jumpToLatest = () => {
    sinceLine.jumpToLatest();
    setAway(false);
  };

  return (
    <ChatFindContext.Provider value={find.open ? find.query : ''}>
    <PictureSourceContext.Provider value={pictures}>
    <div ref={rootRef} tabIndex={-1} onKeyDownCapture={onKeyDownCapture} className="relative flex h-full min-h-0 flex-col bg-pm-bg text-xs text-pm-text outline-none ck-chat" data-testid="session-chat" data-view={mode}>
      {find.open && <ChatFindBar find={find} belowHead={!headerSlot} />}
      {headerSlot ? (
        createPortal(
          <>
            {headerExtra && <span className="flex shrink-0 items-center ck-chat-head-extra">{headerExtra}</span>}
            {/* In the pane header the menu is drawn in the top layer at every width: the header would clip a menu inside it. */}
            {!hideViewMode && <ViewModeToggle mode={mode} onChange={setMode} compact />}
            {headerMenu && <span className="flex shrink-0 items-center ck-chat-head-menu">{headerMenu}</span>}
          </>,
          headerSlot.el,
        )
      ) : (
        <header className="flex h-9 min-w-0 flex-nowrap items-center gap-2 bg-pm-panel px-2 ck-chat-head">
          <span className="min-w-0 truncate ck-chat-model" title={cliVersion ? `CLI ${cliVersion}` : undefined}>
            {model ?? 'Model not known yet'}
          </span>
          {headerExtra && <span className="ml-auto flex shrink-0 items-center ck-chat-head-extra">{headerExtra}</span>}
          {!hideViewMode && <ViewModeToggle mode={mode} onChange={setMode} />}
          {headerMenu && <span className="flex shrink-0 items-center ck-chat-head-menu">{headerMenu}</span>}
        </header>
      )}
      {(fromScreen || mode === 'summary') && (
        <p className="px-2 py-1 text-[11px] text-pm-muted ck-chat-note">
          {fromScreen && (
            <span className="block ck-chat-screen-note" data-testid="session-chat-screen-note">
              {SCREEN_CHAT_NOTE}
            </span>
          )}
          {mode === 'summary' && <span className="block ck-chat-mode-note">{SUMMARY_NOTE}</span>}
        </p>
      )}
      {banner}
      <PlanBar items={plan} />
      <div className="relative flex min-h-0 flex-1 ck-chat-main">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-2 py-2 ck-chat-body">
        {state === 'unavailable' && (
          <div className="ck-empty ck-chat-empty">
            <h2 className="ck-section text-xs font-semibold text-pm-text">Chat unavailable</h2>
            <p className="ck-sub text-pm-muted">{reason ?? 'Chat is not available for this pane.'}</p>
          </div>
        )}
        {state !== 'unavailable' && earlier && <EarlierRow earlier={earlier} onPress={noteWhere} />}
        {state !== 'unavailable' && turns.length === 0 && emptyNote}
        {state !== 'unavailable' && turns.length === 0 && (
          <div className="ck-chat-waiting">
            <p className="ck-sub text-pm-muted ck-chat-waiting-line">
              {fromScreen ? 'Waiting for a message on the terminal…' : source === 'acp' && ready ? t('chat.readyIdle') : source === 'api' || source === 'acp' ? "Waiting for the agent's session…" : "Waiting for the agent's session file…"}
            </p>
            {waitingFor && (
              <p className="mt-0.5 break-words text-[11px] text-pm-muted opacity-70 ck-chat-waiting-for">{waitingFor}</p>
            )}
          </div>
        )}
        {state !== 'unavailable' &&
          turns.map((turn) => (
            <Fragment key={`${mode}:${turn.id}`}>
              {sinceLine.show && sinceLine.report?.firstTurnId === turn.id && <SinceLine report={sinceLine.report} />}
            <TurnView
              paneId={paneId ?? undefined}
              sentFrom={sentFrom.get(turn.id)}
              card={turn.user ? cards.get(turn.user.id) : undefined}
              price={prices.get(turn.id)}
              turn={turn}
              fromScreen={fromScreen}
              markdown={markdown}
              mode={mode}
              canBranch={!!canBranch && !readOnly && !!onBranch}
              branchAlways={turn.id === newestBranchable}
              onBranch={stableBranch}
              helpers={placedHelpers.get(turn.id)}
              onOpenPane={onOpenPane ? stableOpenPane : undefined}
              endings={endings && turn.id === turns[turns.length - 1]?.id ? endings : undefined}
            />
            </Fragment>
          ))}
        {state !== 'unavailable' && pending}
        {away && <JumpToLatest onJump={jumpToLatest} />}
      </div>
      {state !== 'unavailable' && <MessageRail entries={railEntries} scrollRef={scrollRef} rootRef={rootRef} findQuery={find.open ? find.query : ''} />}
      </div>
      {remember && paneId && <RememberSelection paneId={paneId} root={scrollRef} />}
      {dock && <div className="ck-chat-dock">{dock}</div>}
      {aside}
      {state !== 'unavailable' && composer}
      {overlay}
    </div>
    </PictureSourceContext.Provider>
    </ChatFindContext.Provider>
  );
}
