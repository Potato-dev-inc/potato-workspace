// The chat over a terminal pane: reads the pane's session file while it is mounted (TerminalPane mounts it
// only when the person picked Chat). `dock` is what waits on the person, shown under the conversation.
// `reply`: give the chat a message box (the Cockpit's Chat tab does); `blockedReason` switches the box off.
import { ChatPaneContext } from './ChatPane';
import { ChatAnswerContext } from './chatAnswer';
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { leavePane, setActivePane } from '../../lib/ipc-guard';
import { keepGoingContinue, keepGoingTargetKey, keepGoingTargets } from '../../lib/keep-going';
import { openSettingsAt, SETUP_CHECK_ROW_ID } from '../../lib/openSettingsAt';
import { openConnect } from '../../lib/openConnect';
import { usePaneOutbox } from '../../hooks/usePaneOutbox';
import { paneOutboxTransport } from '../../lib/paneOutbox';
import { useHost } from '../../lib/host/context';
import { useComposerDraft } from '../../lib/composerDraft';
import { pickFiles } from '../../lib/attachFiles';
import { usePendingBubbles } from '../../hooks/usePendingBubbles';
import { useSessionChat } from '../../hooks/useSessionChat';
import { useSlashCommands } from '../../lib/slashCommands';
import { desktopDraft } from '../../lib/chatMore';
import { BranchSheet } from '../cockpit/BranchSheet';
import { BranchBanner } from './BranchBanner';
import { TakeoverBanner, useTakenOver } from './TakeoverBanner';
import { useT } from '../../i18n';
import { lentPaneOf, lentSignedOutText } from '../lend/LentChip';
import { useLend } from '../lend/useLend';
import { ChatComposer } from './ChatComposer';
import { ChatExportMenu } from './ChatExportMenu';
import type { ChatMove } from './ChatMove';
import { CollisionBanner } from './CollisionBanner';
import { ToolsOutOfDateBanner } from './ToolsOutOfDateBanner';
import { KeepGoingBanner, plainKeepGoingError } from './KeepGoingBanner';
import type { EndingActions } from './TurnEndingButtons';
import { ProjectBudgetBanner } from './ProjectBudgetBanner';
import { RightSizeLine } from './RightSizeLine';
import { PendingMessages } from './PendingMessages';
import { ScreenQuestionCard } from './ScreenQuestionCard';
import { lastBranchableId, SessionChatView } from './SessionChatView';
import { useSideQuestion } from './useSideQuestion';
import { useChatJump } from '../../lib/chatJump';
import type { ChatHelper } from '../../lib/chat-helpers';
import { chipValueName, configChips, type AcpCommand } from '../../lib/acpChat';
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { readContext } from '../cockpit/rail/railFormat';
import { steadyUsage } from '../../lib/contextWindow';
import { usePaneBranch } from '../cockpit/rail/usePaneBranch';

export interface ChatReply {
  /** Why the message box is switched off, or null. */
  blockedReason: string | null;
  /** The agent is working: the box shows Stop instead of Send (see ChatComposer). */
  running?: boolean;
  /** Stops the agent (a Chat (terminal) pane's Interrupt, a chat session's cancel). */
  onStop?: () => void;
  /** What the agent is doing, in words, for the box footer ("Working…", "Waiting for your answer", "Stopping…"). */
  status?: { text: string; stopping: boolean } | null;
  /**
   * Stops the running turn so a waiting message can go at once ("Send now"). Set for a chat session and a Chat
   * (terminal) pane; without it a waiting message has Cancel only.
   */
  onInterrupt?: () => void;
}

/**
 * The other agent a "usage limit" ending can hand the task to: the first one `keep_going_targets` says is ready.
 * Only asked while the newest turn ended that way. Null while unknown, when none is set up, or when the pane cannot
 * hand over (the command rejects).
 */
function useKeepGoingOffer(paneId: string, wanted: boolean): EndingActions['keepGoing'] {
  const [offer, setOffer] = useState<EndingActions['keepGoing']>(null);
  useEffect(() => {
    if (!wanted) {
      setOffer(null);
      return;
    }
    let live = true;
    keepGoingTargets(paneId).then(
      (offers) => {
        const ready = offers.find((o) => o.ok);
        if (!live) return;
        setOffer(
          ready
            ? {
                label: ready.label,
                run: () =>
                  keepGoingContinue(paneId, keepGoingTargetKey(ready.target), false).then(
                    () => null,
                    (err: unknown) => plainKeepGoingError(err, 'Could not move the task. Try again.'),
                  ),
              }
            : null,
        );
      },
      () => {
        if (live) setOffer(null);
      },
    );
    return () => {
      live = false;
    };
  }, [paneId, wanted]);
  return offer;
}

/**
 * What the chat needs to show "Agent is asking" for a question that only the terminal screen holds (see
 * `ScreenQuestionCard`). Without it the chat never reads the screen.
 */
export interface ScreenAsk {
  /** The pane's status is waiting_input. */
  waiting: boolean;
  /** The pane's status is idle. */
  idle: boolean;
  /** The pane's status is running (its screen is read for a menu that holds still). */
  running?: boolean;
  /** An approval or question card already answers the pane: nothing is added. */
  covered: boolean;
  fallbackText?: string | null;
  onOpenTerminal?: () => void;
  /** The agent's name when this Chat (terminal) pane's agent can answer prompts: the answerable card is drawn. */
  answerable?: string | null;
}

export function SessionChatPanel({ paneId, dock, reply, emptyNote, onOpenPane, screenAsk, helpers, crew, slashCommands, slashAgent, slashWaiting = false, sessionReady = false, onWarm, composerTop, headerSlot, move, chatTitle, onUseLend }: { /** A far chat on a sign-in that ended while this PC lends that PC the agent: start it again on the lend (the last message waits in the new box). */ onUseLend?: (kept: string) => Promise<string | null>; /** The chat's own name, which heads a saved page. */ chatTitle?: string; /** "Move to…": the menu entry, the note under the banners and the sheet (the pane view owns them). */ move?: ChatMove; paneId: string; /** A place in the pane's header for the view switch and the chat buttons (the chat then draws no header row). */ headerSlot?: { el: HTMLElement; compact: boolean }; dock?: ReactNode; reply?: ChatReply; emptyNote?: ReactNode; onOpenPane?: (paneId: string) => void; screenAsk?: ScreenAsk; /** The helpers this pane started through Potato Workspace (rows in the turn they began in). */ helpers?: readonly ChatHelper[]; /** The crew chip, pinned at the top of the chat (agents this chat started). */ crew?: ReactNode; /** A chat session over ACP: the agent's slash commands for the message box (typing "/" opens a menu). */ slashCommands?: readonly AcpCommand[]; /** A chat session over ACP: its agent's id. With it the "/" menu keeps the agent's last list per adapter version and always offers the app's own commands. */ slashAgent?: string; /** The agent's session is still starting (the menu says "Loading commands" until its list comes). */ slashWaiting?: boolean; /** A chat session over ACP whose agent is up and waiting (nothing was said yet): the empty view says it is ready. */ sessionReady?: boolean; /** The message box got the focus. */ onWarm?: () => void; /** Drawn right above the message box (a chat session's settings chips). */ composerTop?: ReactNode }) {
  // The chat on screen: reads queued for the one just left are dropped before they reach the desktop (lib/ipc-guard.ts).
  useLayoutEffect(() => {
    setActivePane(paneId);
    return () => leavePane(paneId);
  }, [paneId]);
  const chat = useSessionChat(paneId, true);
  // The header names the model the chat is on NOW (what its settings menu checks), not the one of its last reply: a mode change restarts the session.
  const modelChip = configChips(useAcpChatState(paneId, !!slashAgent)).find((chip) => chip.category === 'model');
  const slash = useSlashCommands(slashAgent ?? '', chat.cliVersion, slashCommands, slashWaiting);
  const menu = slashAgent ? slash.commands : slashCommands;
  // The half-written message follows the person between the phone and this PC (kept by the PC, words only).
  const remoteDraft = useMemo(() => desktopDraft(paneId), [paneId]);
  const host = useHost();
  const transport = useMemo(() => paneOutboxTransport(host), [host]);
  const outbox = usePaneOutbox(transport, paneId, !!reply);
  const userTexts = useMemo(() => chat.turns.flatMap((turn) => (turn.user ? [turn.user.text] : [])), [chat.turns]);
  const { bubbles, hide } = usePendingBubbles(outbox.messages, userTexts);
  const side = useSideQuestion(paneId, chat.turns);
  // Where the work lands: the branch of the folder the pane works in (a dim line under the box).
  const branch = usePaneBranch(paneId, reply?.running ? 'running' : 'idle', !!reply);
  const jump = useChatJump(paneId);
  // "Branch": the id of the message that started the turn the branch sheet is open for, or null.
  const [branchFor, setBranchFor] = useState<string | null>(null);
  const hasChat = chat.state !== 'unavailable';
  // A chat with no message box is read-only (the terminal pane's chat): no Branch there.
  const canBranch = hasChat && !!reply && host.can?.('branch_lineage') !== false;
  // The Point and Fix draft ('Edit in Chat') for this pane's box: taken only while the box is shown.
  const t = useT();
  // An agent took the standby this chat was: the person's last message goes back in the box, and the box waits for the task.
  const takeover = useTakenOver(paneId);
  const lastSent = userTexts.length > 0 ? userTexts[userTexts.length - 1] : '';
  const [restored, setRestored] = useState<{ paneId: string; text: string; nonce: number } | null>(null);
  const tookId = takeover.helper?.id ?? null;
  useEffect(() => {
    if (tookId && lastSent.trim()) setRestored({ paneId, text: lastSent, nonce: Date.now() });
    // Only when the take-over begins (the helper id appears), not on every new message.
  }, [tookId]); // eslint-disable-line react-hooks/exhaustive-deps
  const pointDraft = useComposerDraft(reply ? paneId : null);
  const draft = restored && restored.paneId === paneId ? restored : pointDraft;
  // The buttons on the newest turn's ending line.
  const newest = chat.turns[chat.turns.length - 1];
  const keepGoing = useKeepGoingOffer(paneId, hasChat && !!reply && newest?.ending?.reason === 'usage_limit');
  // Changes when a turn starts, ends or a line is added to the newest one: the cue to ask again about the project's day.
  const turnSignal = `${chat.turns.length}:${newest?.steps.length ?? 0}:${newest?.end?.id ?? ''}`;
  // The ring in the message box: the newest usage the agent reported (nothing when it did not say its window size).
  const contextReading = useMemo(() => readContext(steadyUsage(paneId, chat.model, chat.usage)), [paneId, chat.model, chat.usage]);
  // A chat on a sign-in lent by my other PC ("Use my own agents"): "Probably signed out" is about THAT sign-in, so it says whose, and Sign in goes to
  // the lending PC's own screen (Connect > Lending), never to the agent's "Check my setup" row on the PC that only runs it.
  const lent = lentPaneOf(useLend(), paneId);
  const turns = useMemo(
    () => (lent ? chat.turns.map((turn) => (turn.ending?.reason === 'signed_out' ? { ...turn, ending: { ...turn.ending, text: lentSignedOutText(lent, t) } } : turn)) : chat.turns),
    [chat.turns, lent?.mine, lent?.grant.peer_device_name, !!lent, t], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const endings: EndingActions | undefined = hasChat
    ? {
        // The last thing the person said, not the newest turn's: a far chat can end with a line (a late tool, a note) that has no message of its own.
        onRetry: reply && lastSent.trim() ? () => outbox.send(lastSent) : undefined,
        onSignIn: lent ? (lent.mine ? () => openConnect('lending') : undefined) : () => openSettingsAt('agents', SETUP_CHECK_ROW_ID),
        onUseLend: onUseLend && !lent ? () => onUseLend(lastSent) : undefined,
        keepGoing,
      }
    : undefined;
  return (
    <ChatPaneContext.Provider value={paneId}>
      <ChatAnswerContext.Provider value={reply ? outbox.send : null}>
      <SessionChatView
        state={chat.state}
        reason={chat.reason}
        waitingFor={chat.waitingFor}
        ready={sessionReady}
        source={chat.source}
        turns={turns}
        model={modelChip ? chipValueName(modelChip) : chat.model}
        cliVersion={chat.cliVersion}
        paneId={paneId}
        jump={jump}
        helpers={helpers}
        onOpenPane={onOpenPane}
        endings={endings}
        earlier={chat.earlier}
        remember
        emptyNote={emptyNote}
        headerExtra={chat.state === 'unavailable' ? undefined : side.button}
        headerSlot={headerSlot}
        headerMenu={hasChat ? <ChatExportMenu paneId={paneId} title={chatTitle} variant={headerSlot ? 'text' : 'icon'} onMove={move?.onMove} /> : undefined}
        banner={
          <>
            {crew}
            {move?.note}
            {takeover.helper && <TakeoverBanner helper={takeover.helper} api={takeover.api} apply={takeover.apply} />}
            <ToolsOutOfDateBanner paneId={paneId} />
            <CollisionBanner paneId={paneId} onOpenPane={onOpenPane} />
            <KeepGoingBanner paneId={paneId} onOpenPane={onOpenPane} />
            <BranchBanner paneId={paneId} onOpenPane={onOpenPane} />
            <ProjectBudgetBanner paneId={paneId} signal={turnSignal} />
            <RightSizeLine paneId={paneId} signal={turnSignal} running={reply?.running} />
          </>
        }
        canBranch={canBranch}
        onBranch={setBranchFor}
        overlay={side.box}
        dock={dock}
        aside={
          screenAsk && (
            <ScreenQuestionCard
              paneId={paneId}
              waiting={screenAsk.waiting}
              idle={screenAsk.idle}
              running={screenAsk.running}
              covered={screenAsk.covered}
              queued={outbox.messages}
              fallbackText={screenAsk.fallbackText}
              onOpenTerminal={screenAsk.onOpenTerminal}
              answerable={screenAsk.answerable}
            />
          )
        }
        pending={reply ? <PendingMessages messages={bubbles} onCancel={outbox.cancel} onHold={outbox.hold} onEdit={outbox.edit} onHide={hide} onSendNow={reply.onInterrupt} onRetry={outbox.send} onStartFresh={reply.onInterrupt} /> : undefined}
        composer={reply ? (
          <ChatComposer onSend={outbox.send} blockedReason={takeover.helper ? t('standby.locked') : reply.blockedReason} draftKey={paneId} remoteDraft={remoteDraft} draft={draft} slashCommands={menu} slashLoading={!!slashAgent && slash.loading} onWarm={slashAgent ? onWarm : undefined} toolbar={composerTop} running={reply.running} onStop={reply.onStop} status={reply.status} attachFiles={pickFiles} contextUsage={contextReading} history={userTexts} footnote={branch ? <>{t('r9.lands')}<span className="ck-chat-where-branch">{branch}</span></> : undefined} />
        ) : undefined}
      />
      {move?.sheet}
      {branchFor !== null && (
        <BranchSheet paneId={paneId} from={{ kind: 'message', user_item_id: branchFor, when: 'after' }} onClose={() => setBranchFor(null)} />
      )}
      </ChatAnswerContext.Provider>
    </ChatPaneContext.Provider>
  );
}
