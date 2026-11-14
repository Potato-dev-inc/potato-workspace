import { errorSentence } from '../../lib/sayError';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PaneMoreMenu, type MoreAction } from './PaneMoreMenu';
import { bellMenuActions } from './bell-menu';
import { useBellLevel } from '../../lib/notify-store';
import { useHeadFold } from './usePaneHeadFold';
import { rememberSelectedTab } from './session-memory';
import type { CockpitApi } from '../../hooks/useCockpit';
import { confirmCloseEnabled, needsCloseConfirm } from '../../lib/close-policy';
import { cockpitApi, type PaneRunInfo, type PaneTranscript, type TurnSummary } from '../../lib/cockpit-api';
import { projectLabel, projectWithCopy, realFolderPath } from './shell-labels';
import { useLoopGuard } from '../../lib/loop-guard';
import { activityText } from '../../lib/pane-activity';
import '../../styles/pane-activity.css';
import '../../styles/live-preview.css';
import '../../styles/pane-chrome.css';
import '../../styles/cockpit-helpers.css';
import { TerminalViewport } from '../TerminalViewport';
import { AgentLogo } from '../common/AgentLogo';
import { DotSpinner } from './DotSpinner';
import { mainPreview, openPreview, previewLabel } from '../../lib/pane-preview';
import { pointApi } from '../../lib/point-api';
import { dockItems, headerStateLine, dockLabel } from './pane-chrome';
import { useT } from '../../i18n';
import { IconGlobe, IconRail } from './Icons';
import { subscribePaneActions, type PaneAction } from '../../lib/pane-actions';
import { SessionRail } from './rail/SessionRail';
import { useRailLayout } from './rail/useRailLayout';
import { helperRows } from './rail/helperRows';
import { chatHelpers } from '../../lib/chat-helpers';
import { DockedCards } from './DockedCards';
import { HelperQuestions, helperQuestionIds } from './HelperQuestions';
import { formatElapsed, spinnerStatus, stateText } from './model';
import { acpResult, acpStatusWords } from './acp-pane';
import { AcpResultStrip } from './AcpResultStrip';
import { DoneList } from './DoneList';
import { ReceiptTab } from './ReceiptTab';
import { TurnFiles } from './turnfiles/TurnFiles';
import { Changes } from './Changes';
import { usePaneWorktree } from './usePaneWorktree';
import { SecondOpinion } from './SecondOpinion';
import { History } from './History';
import { panesSharingFolder } from './history-model';
import { RenameTitle } from './RenameTitle';
import { useLastTurn } from './away-context';
import { SegTabs } from './SegTabs';
import { PaneTabs } from './PaneTabs';
import { Sheet } from './Sheet';
import { paneHeading } from './titles';
import { helperOfLabel, startedByLabel } from '../../lib/pane-helpers';
import { placeLabel, placeTooltip } from '../../lib/wsl-place';
import { isProseStream, transcriptSpeaker } from '../../lib/transcript-labels';
import { UntestedChip } from './UntestedChip';
import { AcpChatDock } from '../chat/AcpChatDock';
import { acpBadge, ACP_LANE, isTerminalChatLane, quietStrip, runStrip, tauriAcpChatApi, terminalChatCapable, terminalChatBadge, type AcpChatApi } from '../../lib/acpChat';
import { useAcpLanes } from '../../hooks/useAcpLanes';
import { useShowTerminals } from '../../lib/showTerminals';
import { AcpConfigChips } from '../chat/AcpConfigChips';
import { HandedToTerminal, handedBlock } from '../chat/HandedToTerminal';
import { HandOverSheet } from '../chat/HandOverSheet';
import { useAcpChatState } from '../../hooks/useAcpChatState';
import { useAcpStop } from '../../hooks/useAcpStop';
import { useHandOver } from '../../hooks/useHandOver';
import type { HandoffControl } from '../../hooks/useHandoff';
import { handoffLabel } from '../../lib/handoff';
import { useTerminalConversation } from '../../hooks/useTerminalConversation';
import '../../styles/cockpit-acp.css';
import { BudgetChip } from './BudgetChip';
import { BorrowedChip } from '../lend/Borrowed';
import { MissionProgress } from './mission/MissionProgress';
import { missionOfPane, useMissions } from '../../lib/missions';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { SaveCrewSheet } from './crews/SaveCrewSheet';
import { SessionChatPanel, type ScreenAsk } from '../chat/SessionChatPanel';
import { useChatJump } from '../../lib/chatJump';
import { clearChatTabRequest, useChatTabRequest } from '../../lib/chatTab';
import { composerBlock } from '../../lib/paneOutbox';
import { onComposerInsert } from '../../lib/composer-insert';
import { LiveChip } from './live/LiveChip';
import { FileTab } from '../files/FileTab';
import { FileTabsBar } from '../files/FileTabsBar';
import { clearFileFocus, fileTabId, pathOfTab, usePaneFiles } from '../../lib/file-tabs';
import { LiveStatusContext } from './live/useLiveRoom';

type Tab = 'mission' | 'terminal' | 'chat' | 'changes' | 'transcript' | 'receipt' | 'history' | `file:${string}`;

/** The tab each pane was last on, kept for this app run only (not on disk). A remount opens the same view. */
const rememberedTabs = new Map<string, Tab>();

const TABS: readonly string[] = ['mission', 'terminal', 'chat', 'changes', 'transcript', 'receipt', 'history'];

/** The tab a pane was last on this run, if any. */
export function rememberedTabOf(paneId: string): string | undefined {
  return rememberedTabs.get(paneId);
}

/** Starts a pane on a tab from the last run (session-memory.ts). Unknown names and panes already on a tab are left alone. */
export function seedRememberedTab(paneId: string, tab: string | undefined): void {
  if (tab && TABS.includes(tab) && !rememberedTabs.has(paneId)) rememberedTabs.set(paneId, tab as Tab);
}

/** Forgets every remembered tab (tests start each case on the default view). */
export function forgetRememberedTabs(): void {
  rememberedTabs.clear();
}

/** Run info + transcript for the Transcript and Receipt tabs. `null` = the pane has no run. */
export function useRunData(paneId: string, active: boolean, status: string) {
  const [info, setInfo] = useState<PaneRunInfo | null | undefined>(undefined);
  const [transcript, setTranscript] = useState<PaneTranscript | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setInfo(undefined);
    setTranscript(undefined);
    setError(null);
  }, [paneId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    Promise.all([cockpitApi.paneRunInfo(paneId), cockpitApi.paneTranscript(paneId)])
      .then(([i, t]) => {
        if (cancelled) return;
        setInfo(i);
        setTranscript(t);
        setError(null);
      })
      .catch((err) => !cancelled && setError(errorSentence(err)));
    return () => {
      cancelled = true;
    };
  }, [paneId, active, status, nonce]);

  // The tab has no Refresh button: it looks again when the window gets focus back.
  useEffect(() => {
    if (!active) return;
    const onFocus = () => setNonce((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [active]);

  // The pane reads idle a moment before its run settles (the turn end is confirmed after the screen
  // goes quiet), and the pane's status does not change again then: a fetch made at "idle" kept
  // showing "Result: Still working" for a finished turn (live r13, tour chapter 05). While the run is
  // still unsettled, look again.
  const unsettled = !!info && UNSETTLED_RUN.has(info.status);
  useEffect(() => {
    if (!active || !unsettled) return;
    const timer = setTimeout(() => setNonce((n) => n + 1), RUN_SETTLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [active, unsettled, info]);

  return { info, transcript, error, refresh: () => setNonce((n) => n + 1) };
}

/** Run statuses that change without the pane's status changing. */
const UNSETTLED_RUN = new Set(['queued', 'starting', 'running', 'cancelling']);
/** How often an open Transcript or Receipt tab looks again while its run is unsettled. */
export const RUN_SETTLE_POLL_MS = 1500;

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="ck-empty">
      <h2 className="ck-section">{title}</h2>
      <p className="ck-sub">{body}</p>
    </div>
  );
}

export function PaneView({
  c,
  paneId,
  onWhatBroke,
  acp = tauriAcpChatApi,
  handoff,
}: {
  c: CockpitApi;
  paneId: string;
  /** The chat-session calls (state, settings, hand-over). Replaceable in tests. */
  acp?: AcpChatApi;
  /** Opens "What broke the tests?" for this pane (History tab). Absent: no button. */
  onWhatBroke?: (paneId: string) => void;
  /** "Hand off": the cockpit's shared handoff starter (the one "Handoff from here" uses). Absent: no button. */
  handoff?: HandoffControl;
}) {
  const t = useT();
  const pane = c.registry.panes.get(paneId);
  const [tabPicked, setTabRaw] = useState<Tab>(() => rememberedTabs.get(paneId) ?? 'terminal');
  // A chat session over ACP has no terminal behind it: its Chat view is the pane, so it never shows a Terminal view.
  const isAcp = pane?.info.lane === ACP_LANE;
  const home: Tab = isAcp ? 'chat' : 'terminal';
  const tab: Tab = isAcp && tabPicked === 'terminal' ? 'chat' : tabPicked;
  // Every choice the person makes is remembered for this pane. Automatic fallbacks use setTabRaw, so they do not overwrite it.
  const setTab = useCallback(
    (t: Tab) => {
      rememberedTabs.set(paneId, t);
      rememberSelectedTab(paneId, t);
      setTabRaw(t);
    },
    [paneId],
  );
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [reflowKey, setReflowKey] = useState(0);
  const getSelectionRef = useRef<(() => string) | null>(null);
  // A chat session reads its run too (the result strip under the conversation); a terminal pane only for the tabs that show it.
  const run = useRunData(paneId, isAcp || (tab !== 'terminal' && tab !== 'chat'), pane?.status ?? '');
  // The cockpit window shares its turn summaries; a pane's own window has none, so a chat session asks for its own.
  const sharedTurn = useLastTurn(paneId);
  const [ownTurn, setOwnTurn] = useState<TurnSummary | undefined>(undefined);
  useEffect(() => {
    if (!isAcp || sharedTurn) return;
    let cancelled = false;
    cockpitApi
      .turnSummaries(paneId)
      .then((t) => !cancelled && setOwnTurn(Array.isArray(t) ? t[t.length - 1] : undefined))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isAcp, sharedTurn, paneId, pane?.status]);
  const lastTurn = sharedTurn ?? ownTurn;
  const worktree = usePaneWorktree(paneId, pane?.status ?? '');
  const { signals } = useLoopGuard();
  const rail = useRailLayout();
  // The header folds its lowest-priority actions into the ⋯ menu when the pane is narrow (see usePaneHeadFold).
  const headRef = useRef<HTMLElement>(null);
  const [chatSlot, setChatSlot] = useState<HTMLElement | null>(null);
  const fold = useHeadFold(headRef, `${tab}|${pane?.status}|${pane?.info.title}|${rail.fits}|${rail.open}|${paneId}`);
  const [dockIx, setDockIx] = useState(0);
  const [details, setDetails] = useState(false);
  // "Save this team" (crews): the sheet that turns this pane and its helpers into a saved crew.
  const [saveTeam, setSaveTeam] = useState(false);
  // A pane one of a mission's agents works in gets a Mission tab: the mission's Progress.
  const missions = useMissions();
  const mission = missionOfPane(missions.missions, paneId);
  // The Chat tab reads an agent's session file, or its screen when it writes none, so a plain shell gets none (the rule TerminalPane uses).
  const listing = useAgentRegistry();
  // The Live Room status the cockpit shares; the chip shows only for a pane that is in the room.
  const liveStatus = useContext(LiveStatusContext);
  const agentType = pane?.info.agent_type ?? '';
  // A Chat (terminal) pane is a normal terminal pane: it opens on its Chat tab, and the Terminal tab stays one click away.
  const isTerminalChat = isTerminalChatLane(pane?.info.lane);
  const chatAllowed = isAcp || listing.agents.find((a) => a.id === agentType)?.kind !== 'shell';
  // A chat session: its state (settings, commands, "open in a terminal"). An ordinary pane may hold a chat conversation
  // that was handed to it: then it can hand it back.
  const acpState = useAcpChatState(paneId, isAcp, acp);
  const acpStop = useAcpStop(paneId, !!acpState?.turnInFlight, acp);
  // A Chat (terminal) pane whose agent has a prompt parser answers its questions from the chat (AnswerableQuestionCard).
  const laneView = useAcpLanes(isTerminalChat, acp);
  const answersPrompts = isTerminalChat && terminalChatCapable(laneView).some((a) => a.id === agentType && a.can_answer_prompts);
  const heldConversation = useTerminalConversation(paneId, !!pane && !isAcp, acp);
  const handOver = useHandOver({ api: acp, select: c.select, notify: c.notify, resetOn: paneId });
  const inTerminal = isAcp ? (acpState?.inTerminal ?? null) : null;
  // The chat is a saved conversation unless the backend says it is not (an older backend says nothing: then it is).
  // "Open in terminal" is a terminal control: hidden while terminals are (a chat that is already in a terminal still shows its way back).
  const showTerminals = useShowTerminals();
  const canHandOver = showTerminals && isAcp && !!acpState && !inTerminal && acpState.conversation !== null;

  useEffect(() => {
    setTabRaw(rememberedTabs.get(paneId) ?? 'terminal');
    setConfirm(false);
    setRenaming(false);
    setDetails(false);
    setSaveTeam(false);
    setDockIx(0);
  }, [paneId]);

  // A chat session opens on its Chat tab (it has no terminal to show). A Chat (terminal) pane opens there too.
  useEffect(() => {
    if ((isAcp || isTerminalChat) && !rememberedTabs.has(paneId)) setTabRaw('chat');
  }, [paneId, isAcp, isTerminalChat]);

  // A search result opens this pane's Chat (the chat itself scrolls to the message).
  const jump = useChatJump(paneId);
  useEffect(() => {
    if (jump && chatAllowed) setTab('chat');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.nonce, paneId]);

  // Point and Fix put a message into this pane's Chat box (Edit in Chat): the Chat tab opens to show it.
  useEffect(
    () =>
      pointApi.onDraft((id) => {
        if (id === paneId && chatAllowed) setTab('chat');
      }),
    [paneId, chatAllowed],
  );

  // An old chat continued in this new pane asks for the Chat tab (lib/chatTab.ts).
  const chatTabAsk = useChatTabRequest(paneId);
  useEffect(() => {
    if (!chatTabAsk || !chatAllowed) return;
    setTab('chat');
    clearChatTabRequest(chatTabAsk);
  }, [chatTabAsk, chatAllowed]);

  // Files open beside the chat (lib/file-tabs.ts): opening one brings its tab to the front; closing the front one goes home.
  const openFiles = usePaneFiles(paneId);
  useEffect(() => {
    const ask = openFiles.focus;
    if (!ask) return;
    setTabRaw(fileTabId(ask.path));
    clearFileFocus(paneId, ask.nonce);
  }, [openFiles.focus, paneId]);
  useEffect(() => {
    const path = pathOfTab(tab);
    if (path !== null && !openFiles.files.includes(path) && !openFiles.focus) {
      const before = rememberedTabs.get(paneId);
      setTabRaw(before && pathOfTab(before) === null ? before : home);
    }
  }, [tab, openFiles, paneId, home]);
  // Text put into this pane's message box (Mention in chat, Tell the agent) opens the Chat tab to show it.
  useEffect(
    () =>
      onComposerInsert((id) => {
        if (id === paneId && chatAllowed) setTab('chat');
      }),
    [paneId, chatAllowed, setTab],
  );

  useEffect(() => {
    // A view that is no longer offered falls back to the Terminal for now; the remembered choice stays.
    if (tab === 'changes' && !worktree) setTabRaw(home);
    if (tab === 'mission' && !mission) setTabRaw(home);
    if (tab === 'chat' && !chatAllowed) setTabRaw('terminal');
  }, [tab, worktree, mission, chatAllowed, home]);

  const copySelection = useCallback(async () => {
    const text = tab === 'terminal' ? (getSelectionRef.current?.() ?? '') : (window.getSelection()?.toString() ?? '');
    if (!text) {
      c.notify(t('pane.nothingSelected'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      c.notify(t('pane.copied'));
    } catch {
      c.notify(t('pane.copyFailed'));
    }
  }, [c, tab, t]);

  // The pane's actions (Rename, Reflow, Copy selection, Details, Close) are asked for from the sidebar row's
  // right-click menu and the command palette (lib/pane-actions.ts); this view runs them for its own pane.
  const paneStatus = pane?.status ?? '';
  const runPaneAction = (action: PaneAction) => {
    if (action === 'rename') setRenaming(true);
    else if (action === 'reflow') {
      if (isAcp) return;
      setTab('terminal');
      setReflowKey((k) => k + 1);
    } else if (action === 'copy') void copySelection();
    else if (action === 'details') setDetails(true);
    else if (action === 'close') {
      void confirmCloseEnabled().then((on) => {
        if (needsCloseConfirm(paneStatus, on)) setConfirm(true);
        else void c.closePane(paneId);
      });
    }
  };
  const runPaneActionRef = useRef(runPaneAction);
  runPaneActionRef.current = runPaneAction;
  useEffect(() => subscribePaneActions(paneId, (action) => runPaneActionRef.current(action)), [paneId]);

  // The agent's bell (how much it may interrupt). Hooks must run on every render, before the "opening" return below,
  // or a pane that shows up a moment later crashes its window (React #310). A helper keeps its own, quieter bell.
  const bellIsHelper =
    !!pane && !!helperOfLabel(c.registry.paneList, paneId, (p) => paneHeading(p.info, c.names.get(p.info.id) ?? p.info.agent_type).primary);
  const bellAgent = pane?.info.agent_type ?? '';
  const [bell, setBell] = useBellLevel(bellIsHelper ? `helper:${bellAgent}` : bellAgent, bellIsHelper);

  if (!pane) {
    return (
      <div className="ck-spawn">
        <h1 className="ck-title">{t('pane.opening')}</h1>
        <p className="ck-sub">{t('pane.openingBody')}</p>
      </div>
    );
  }

  const { info } = pane;
  const since = c.statusSince.get(paneId);
  const prompt = c.prompts[paneId];
  const name = c.names.get(paneId) ?? info.agent_type;
  const heading = paneHeading(info, name);
  const projectLine = [heading.secondary, projectWithCopy(info.cwd)].filter(Boolean).join(' · ');
  // A pane an agent started through Potato Workspace: names its parent and opens it.
  const startedBy = startedByLabel(info);
  const helperOf = helperOfLabel(c.registry.paneList, paneId, (p) => paneHeading(p.info, c.names.get(p.info.id) ?? p.info.agent_type).primary);
  const waiting = pane.status === 'waiting_input';
  const elapsed = waiting && since ? formatElapsed(c.now - since) : null;
  const stateLine = isAcp
    ? waiting && elapsed
      ? `${acpStatusWords(pane.status)} · ${elapsed}`
      : acpStatusWords(pane.status)
    : waiting && elapsed
      ? t('pane.needsYouElapsed', { elapsed })
      : stateText(pane.status);
  const headLine = headerStateLine({
    waiting,
    headline: prompt?.risk?.headline,
    elapsed,
    doing: activityText(pane.status, c.activities?.[paneId]),
    fallback: stateLine,
  });
  const preview = mainPreview(c.previews, paneId);

  // What waits on the person, one card at a time inside the Terminal tab; the tab strip never moves.
  const asking = waiting && !!prompt && prompt.choices.length > 0;
  const dock = dockItems(asking, !!signals[paneId]);
  const dockNow = dock.length > 0 ? dock[dockIx % dock.length] : null;
  const dockHeadline = asking ? (prompt?.risk?.headline ?? t('pane.question')) : t('pane.looksStuck');
  const cycleDock = () => setDockIx((i) => i + 1);
  // A pane that waits with no card to answer on (a login or setup screen, a question no profile knows): Chat shows
  // "Agent is asking" with what the terminal asks, so the person never has to open the terminal.
  // The same card is the safety net for a pane that is only idle with a menu on its screen (see ScreenQuestionCard).
  const screenAsk: ScreenAsk = {
    waiting,
    idle: pane.status === 'idle',
    running: pane.status === 'running',
    // A chat session over ACP asks through its own cards (AcpChatDock): the screen has nothing to add.
    covered: asking || isAcp,
    fallbackText: prompt?.summary || prompt?.risk?.headline,
    onOpenTerminal: () => setTab('terminal'),
    answerable: answersPrompts ? agentLabel(listing, agentType) : null,
  };
  // The Chat tab shows the same docked cards as the Terminal tab, under the conversation.
  // The questions of this pane's helpers (its direct helpers and, for the top pane, every helper under it) wait here too.
  const helperAsks = helperQuestionIds(c, paneId);
  // The helpers this pane's agent started: compact rows in its chat, in the turn they began in. A card waiting on the
  // person counts as "needs you" whatever the helper's status says.
  const askingPanes = new Set(c.asked.questions.map((q) => q.pane_id).filter((id): id is string => !!id));
  const startedHelpers = chatHelpers(c.registry.paneList, paneId, (p) => c.names.get(p.info.id) ?? p.info.agent_type, askingPanes);
  const result = isAcp ? acpResult(lastTurn, run.info?.receipt) : null;
  const chatDock =
    dockNow || helperAsks.length > 0 || isAcp ? (
      <>
        {inTerminal && (
          <HandedToTerminal
            terminalPaneId={inTerminal.paneId}
            busy={handOver.busy}
            onBack={() => handOver.start('toChat', acpState?.conversation ?? paneId)}
            onGoToTerminal={(id) => c.select(id)}
          />
        )}
        {isAcp && <AcpChatDock c={c} paneId={paneId} paneName={name} api={acp} stopper={acpStop} />}
        {isAcp && result && <AcpResultStrip result={result} />}
        {isAcp && <DoneList paneId={paneId} cwd={info.cwd} />}
        <HelperQuestions c={c} ids={helperAsks} />
        {dockNow && <DockedCards c={c} paneId={paneId} dock={dock} dockNow={dockNow} onMore={cycleDock} />}
      </>
    ) : null;

  // The ⋯ menu carries the bell's four levels (the hook runs above the early return).
  const bellActions = bellMenuActions(bell, setBell, t);

  const copyTotals = worktree?.summary ?? null;
  // What the narrow header moved out: the same buttons, one menu row each (lowest priority first).
  const moreActions: MoreAction[] = [];
  if (fold >= 1 && handoff && handoff.allowed(paneId)) {
    moreActions.push({
      id: 'handoff',
      label: handoff.mode === 'file' ? handoffLabel(handoff.mode) : t('pane.handOff'),
      title: handoff.mode === 'file' ? t('pane.handoffFileTip') : t('pane.handoffAgentTip'),
      disabled: handoff.busy,
      onSelect: () => handoff.start(paneId),
    });
  }
  if (fold >= 1 && preview) {
    moreActions.push({ id: 'preview-browser', label: t('pane.previewBrowserTip'), onSelect: () => void openPreview(preview.url).catch(() => c.notify(t('pane.previewFailed'))) });
  }
  if (fold >= 2 && preview) {
    moreActions.push({ id: 'preview', label: t('pane.preview'), onSelect: () => void pointApi.openPreview(paneId, preview.port).catch((e: unknown) => c.notify(typeof e === 'string' ? e : t('pane.previewFailed'))) });
  }
  if (fold >= 2 && canHandOver) {
    moreActions.push({ id: 'open-in-terminal', label: t('pane.openInTerminal'), title: t('pane.openInTerminalTip'), disabled: handOver.busy, onSelect: () => handOver.start('toTerminal', acpState?.conversation ?? paneId) });
  }
  if (fold >= 2 && heldConversation) {
    moreActions.push({ id: 'back-to-chat', label: t('pane.backToChat'), title: t('pane.backToChatTip'), disabled: handOver.busy, onSelect: () => handOver.start('toChat', heldConversation.conversation) });
  }

  return (
    <div className="ck-pane" data-pane-tile={paneId}>
      <PaneTabs c={c} paneId={paneId} />
      <header className="ck-pane-head" ref={headRef} data-fold={fold}>
        <div className="ck-pane-id">
          <RenameTitle
            text={heading.primary}
            current={info.title ?? ''}
            editing={renaming}
            onEditingChange={setRenaming}
            onSave={(title) => void c.rename(paneId, title)}
          />
          <span className="ck-sub-inline" title={realFolderPath(info.cwd)}>
            {projectLine}
          </span>
          {info.account_label && <span className="ck-sub-inline" data-testid="pane-account">{info.account_label}</span>}
          {placeLabel(info.place) && (
            <span className="ck-sub-inline" data-testid="pane-place" title={placeTooltip(info.place)}>
              {placeLabel(info.place)}
            </span>
          )}
          {startedBy && (
            <span className="ck-started-by" data-testid="pane-started-by" title={startedBy.title}>
              {startedBy.text}
            </span>
          )}
          {helperOf && (
            <button type="button" className="ck-helper-of" onClick={() => c.select(helperOf.parentId)} title={t('pane.openParent')}>
              {helperOf.text}
            </button>
          )}
        </div>
        <SegTabs
          label={t('pane.viewLabel')}
          value={tab}
          onChange={setTab}
          options={[
            ...(mission ? [{ id: 'mission' as const, label: t('pane.tabMission') }] : []),
            ...(isAcp ? [] : [{ id: 'terminal' as const, label: t('pane.tabTerminal') }]),
            ...(chatAllowed ? [{ id: 'chat' as const, label: t('pane.tabChat') }] : []),
            ...(worktree ? [{ id: 'changes' as const, label: t('pane.tabChanges'), badge: worktree.summary?.files_changed || undefined }] : []),
          ]}
        />
        <span className="ck-head-gap" aria-hidden="true" />
        {tab === 'chat' && chatAllowed && <span className="ck-head-chat" ref={setChatSlot} data-testid="pane-head-chat" />}
        <UntestedChip agent={info.agent_type} />
        {isAcp && fold < 2 && (
          <span className="ck-chip-label ck-lane-chip" data-testid="pane-lane" title={t('pane.laneChatTip')}>
            {acpBadge()}
          </span>
        )}
        {isTerminalChat && fold < 2 && (
          <span className="ck-chip-label ck-lane-chip" data-testid="pane-lane" title={t('pane.laneTerminalChatTip')}>
            {terminalChatBadge()}
          </span>
        )}
        {canHandOver && fold < 2 && (
          <button
            type="button"
            className="ck-handover-btn"
            data-testid="open-in-terminal"
            disabled={handOver.busy}
            title={t('pane.openInTerminalTip')}
            onClick={() => handOver.start('toTerminal', acpState?.conversation ?? paneId)}
          >
            {t('pane.openInTerminal')}
          </button>
        )}
        {heldConversation && fold < 2 && (
          <button
            type="button"
            className="ck-handover-btn"
            data-testid="back-to-chat"
            disabled={handOver.busy}
            title={t('pane.backToChatTip')}
            onClick={() => handOver.start('toChat', heldConversation.conversation)}
          >
            {t('pane.backToChat')}
          </button>
        )}
        <LiveChip paneId={paneId} status={liveStatus} />
        <BudgetChip paneId={paneId} refreshKey={pane.status} onNotify={c.notify} />
        <BorrowedChip paneId={paneId} />
        <div className="ck-pane-state" data-compact={fold >= 2 ? 'true' : undefined}>
          <DotSpinner status={spinnerStatus(pane.status)} />
          <span className="ck-pane-doing" title={stateLine}>
            {headLine}
          </span>
        </div>
        {preview && fold < 2 && (
          <button
            type="button"
            className="ck-preview-chip"
            title={t('pane.previewTip', { url: preview.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })}
            onClick={() =>
              void pointApi.openPreview(paneId, preview.port).catch((e: unknown) => c.notify(typeof e === 'string' ? e : t('pane.previewFailed')))
            }
          >
            <IconGlobe />
            <span>{t('pane.preview')}</span>
          </button>
        )}
        {preview && fold < 1 && (
          <button
            type="button"
            className="ck-icon-btn"
            aria-label={t('pane.previewBrowserAria')}
            title={t('pane.previewBrowserTip')}
            onClick={() => void openPreview(preview.url).catch(() => c.notify(t('pane.previewFailed')))}
          >
            <IconGlobe />
          </button>
        )}
        {handoff && handoff.allowed(paneId) && fold < 1 && (
          <button
            type="button"
            className="ck-handover-btn"
            data-testid="pane-handoff"
            disabled={handoff.busy}
            title={handoff.mode === 'file' ? t('pane.handoffFileTip') : t('pane.handoffAgentTip')}
            onClick={() => handoff.start(paneId)}
          >
            {handoff.busy ? t('pane.handingOff') : handoff.mode === 'file' ? handoffLabel(handoff.mode) : t('pane.handOff')}
          </button>
        )}
        <PaneMoreMenu<'transcript' | 'receipt' | 'history'>
          label={t('pane.more')}
          value={tab}
          onPick={setTab}
          actions={[...moreActions, ...bellActions]}
          items={[
            { id: 'transcript', label: t('pane.moreTranscript') },
            { id: 'receipt', label: t('pane.moreReceipt') },
            { id: 'history', label: t('pane.moreHistory') },
          ]}
        />
        {rail.fits && (
          <button
            type="button"
            className="ck-icon-btn"
            aria-label={rail.open ? t('pane.railHide') : t('pane.railShow')}
            aria-pressed={rail.open}
            title={rail.open ? t('pane.railHideTip') : t('pane.railShowTip')}
            onClick={rail.toggle}
          >
            <IconRail />
          </button>
        )}
      </header>

      <FileTabsBar paneId={paneId} files={openFiles.files} active={tab} onPick={(id) => setTabRaw(id)} />

      {dockNow && tab !== 'terminal' && tab !== 'chat' && (
        <button type="button" className="ck-dock-bar" onClick={() => setTab('terminal')} aria-label={t('pane.dockBarAria', { headline: dockHeadline })}>
          <span className="ck-dock-bar-dot" aria-hidden="true" />
          <span className="ck-dock-bar-text">{t('pane.dockBarText', { headline: dockHeadline })}</span>
          <span className="ck-dock-bar-go">{dockLabel(dockNow)} ›</span>
        </button>
      )}

      <div className="ck-pane-row">
        <div className="ck-pane-body">
          {tab === 'mission' && mission && (
            <div className="ck-scroll ck-fade-in" key="mission">
              <MissionProgress mission={mission} onChanged={missions.reload} onOpenPane={(id) => c.select(id)} onNotify={c.notify} />
            </div>
          )}
          {tab === 'terminal' && !isAcp && (
            <div className="ck-term-wrap" key={paneId}>
              {dockNow && <DockedCards c={c} paneId={paneId} dock={dock} dockNow={dockNow} onMore={cycleDock} />}
              <div className="ck-term-slot">
                <TerminalViewport pane={pane} registry={c.registry} chrome={false}
                  redrawKey={reflowKey}
                  getSelectionRef={getSelectionRef}
                />
              </div>
            </div>
          )}
          {tab === 'chat' && chatAllowed && (
            <div className="ck-scroll ck-fade-in" key="chat" data-pane-id={paneId}>
              <SessionChatPanel
                paneId={paneId}
                dock={chatDock}
                screenAsk={screenAsk}
                headerSlot={chatSlot ? { el: chatSlot, compact: fold >= 3 } : undefined}
                helpers={startedHelpers}
                reply={{
                  blockedReason: inTerminal ? handedBlock() : composerBlock(pane, !chatAllowed, isAcp),
                  // A Chat (terminal) pane: while the agent works, the box shows Stop (the pane menu's Interrupt).
                  // A chat session over ACP: the same Stop the dock's quiet question uses; the words ride in the box footer.
                  running: isAcp ? !!acpState?.turnInFlight : isTerminalChat && pane.status === 'running',
                  onStop: isAcp ? acpStop.stop : isTerminalChat ? () => void c.interrupt(paneId) : undefined,
                  status: isAcp && !quietStrip(acpState, acpStop.asked) ? runStrip(acpState, acpStop.asked) : null,
                  // "Send now" on a waiting message: stop the turn, the message goes when it ends.
                  onInterrupt: isAcp ? () => void acp.cancel(paneId).catch(() => undefined) : isTerminalChat ? () => void c.interrupt(paneId) : undefined,
                }}
                onOpenPane={(id) => c.select(id)}
                slashCommands={isAcp ? acpState?.commands : undefined}
                composerTop={isAcp ? <AcpConfigChips paneId={paneId} state={acpState} api={acp} /> : undefined}
              />
            </div>
          )}
          {tab === 'changes' && worktree && (
            <div className="ck-scroll ck-fade-in" key="changes">
              <Changes
                paneId={paneId}
                status={pane?.status ?? ''}
                turnReview={<TurnFiles paneId={paneId} status={pane?.status ?? ''} />}
                secondOpinion={<SecondOpinion paneId={paneId} status={pane?.status ?? ''} />}
              />
            </div>
          )}
          {pathOfTab(tab) !== null && openFiles.files.includes(pathOfTab(tab)!) && (
            <FileTab key={tab} paneId={paneId} path={pathOfTab(tab)!} canTell={chatAllowed} refreshKey={pane?.status ?? ''} />
          )}
          {tab === 'transcript' && (
            <div className="ck-scroll ck-fade-in" key="transcript">
              {run.error ? (
                <div className="ck-empty">
                  <h2 className="ck-section">{t('pane.transcriptUnavailable')}</h2>
                  <p className="ck-sub">{t('pane.transcriptLoadFailed')}</p>
                  <button type="button" className="ck-btn ck-btn--secondary" onClick={() => run.refresh()}>
                    {t('pane.tryAgain')}
                  </button>
                </div>
              ) : run.transcript === undefined ? (
                <p className="ck-sub ck-pad">{t('pane.loading')}</p>
              ) : run.transcript === null || run.transcript.chunks.length === 0 ? (
                <Empty
                  title={t('pane.noTranscript')}
                  body={
                    run.info === null
                      ? t('pane.noTranscriptHanded')
                      : t('pane.noTranscriptYet')
                  }
                />
              ) : (
                <div className="ck-transcript">
                  {run.transcript.chunks.map((chunk, i) => (
                    <div key={i} className={`ck-chunk${isProseStream(chunk.stream) ? ' ck-chunk--prose' : ''}`}>
                      <span className="ck-chunk-stream">{transcriptSpeaker(chunk.stream, name)}</span>
                      <pre>{chunk.text}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'history' && (
            <History
              paneId={paneId}
              status={pane.status}
              now={c.now}
              notify={c.notify}
              agentName={name}
              sharedWith={panesSharingFolder(c.registry.paneList, c.names, paneId)}
              onWhatBroke={onWhatBroke}
            />
          )}
          {tab === 'receipt' && (
            <div className="ck-scroll ck-fade-in" key="receipt">
              <ReceiptTab
                info={run.info}
                error={run.error}
                lastTurn={lastTurn}
                now={c.now}
                copy={copyTotals}
                agentName={name}
                // An isolated pane has its own Changes tab, which holds the second opinion.
                secondOpinion={!worktree ? <SecondOpinion paneId={paneId} status={pane?.status ?? ''} /> : null}
                review={!worktree ? <TurnFiles paneId={paneId} status={pane?.status ?? ''} /> : null}
              />
            </div>
          )}
        </div>
        {rail.visible && (
          <SessionRail
            paneId={paneId}
            status={pane.status}
            cwd={info.cwd}
            agentName={name}
            accountLabel={info.account_label}
            readsChat={chatAllowed}
            helperOf={helperOf}
            helpers={helperRows(c.registry.paneList, paneId, (p) => c.names.get(p.info.id) ?? p.info.agent_type)}
            onOpenChanges={worktree ? () => setTab('changes') : () => setTab('receipt')}
            onOpenPane={(id) => c.select(id)}
            onSaveTeam={() => setSaveTeam(true)}
          />
        )}
      </div>

      {saveTeam && (
        <SaveCrewSheet
          paneId={paneId}
          agentName={(id) => agentLabel(listing, id)}
          onClose={() => setSaveTeam(false)}
          onSaved={(crewName) => {
            setSaveTeam(false);
            c.notify(t('pane.crewSaved', { name: crewName }));
          }}
        />
      )}

      {details && (
        <Sheet labelledBy="ck-details-t" onClose={() => setDetails(false)}>
          <h2 className="ck-section" id="ck-details-t">
            {t('pane.details')}
          </h2>
          <dl className="ck-facts ck-facts--details">
            <div className="ck-facts-row">
              <dt>{t('pane.detailFolder')}</dt>
              <dd className="ck-mono">{info.cwd}</dd>
            </div>
            {worktree && (
              <div className="ck-facts-row">
                <dt>{t('pane.detailCopy')}</dt>
                <dd>
                  <span className="ck-mono">{worktree.branch}</span> {t('pane.detailFrom')} <span className="ck-mono">{worktree.base}</span> {t('pane.detailIn')} {projectLabel(worktree.repo)}
                </dd>
              </div>
            )}
            <div className="ck-facts-row">
              <dt>{t('pane.detailScreen')}</dt>
              <dd className="ck-mono">
                {info.cols}×{info.rows}
              </dd>
            </div>
            <div className="ck-facts-row">
              <dt>{t('pane.detailPid')}</dt>
              <dd className="ck-mono">{info.pid}</dd>
            </div>
          </dl>
          <div className="ck-sheet-actions">
            <button type="button" className="ck-btn ck-btn--secondary" autoFocus onClick={() => setDetails(false)}>
              {t('pane.done')}
            </button>
          </div>
        </Sheet>
      )}

      {handOver.ask && <HandOverSheet ask={handOver.ask} busy={handOver.busy} onConfirm={handOver.confirm} onCancel={handOver.cancel} />}

      {confirm && (
        <Sheet labelledBy="ck-close-t" onClose={() => setConfirm(false)}>
            <h2 className="ck-section" id="ck-close-t">
              {t('pane.closeAsk', { name })}
            </h2>
            <p className="ck-sub">{t('pane.closeBody', { name })}</p>
            <div className="ck-sheet-actions">
              <button type="button" className="ck-btn ck-btn--secondary" autoFocus onClick={() => setConfirm(false)}>
                {t('pane.keepRunning')}
              </button>
              <button
                type="button"
                className="ck-btn ck-btn--primary"
                onClick={() => {
                  setConfirm(false);
                  void c.closePane(paneId);
                }}
              >
                {t('pane.closeAgent')}
              </button>
            </div>
        </Sheet>
      )}
    </div>
  );
}
