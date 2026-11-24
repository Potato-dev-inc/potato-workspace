// Cockpit window (`index.html?cockpit=1`): one window that orchestrates every agent pane.
import { useNudgeOnAction } from './lib/desktop-nudge';
import { useFollowFocusedProject } from './hooks/useFollowFocusedProject';
import { startDockBrowserBridge } from './lib/dock-browser';
import { openBrowserPane, openMinionView } from './lib/task-view';
import { OPEN_HELPER_EVENT } from './lib/openHelper';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AgentDoctor } from './components/cockpit/AgentDoctor';
import { markSpawned } from './lib/agent-health';
import { useThemeAttrs } from './lib/theme-tone';
import { useCockpit } from './hooks/useCockpit';
import { useAttention } from './hooks/useAttention';
import { useComfortRoot } from './lib/comfort/root';
import { useSpeakFinished } from './lib/comfort/speak';
import { useHandoff } from './hooks/useHandoff';
import { useMarkupSendRecorder } from './hooks/useMarkupSends';
import { useAway } from './hooks/useAway';
import { LastTurnContext } from './components/cockpit/away-context';
import { AwayDigest } from './components/cockpit/AwayDigest';
import { Inbox } from './components/cockpit/Inbox';
import { PaneView } from './components/cockpit/PaneView';
import { requestPaneAction } from './lib/pane-actions';
import { useFarHosts } from './lib/host/useFarHosts';
import { Palette, type PaletteMode } from './components/cockpit/Palette';
import { JumpOutCard } from './components/cockpit/JumpOutCard';
import { FarNeedsContext, NeedsYouContext, useNeedsYouSource, type FarNeeds } from './hooks/useNeedsYou';
import { useTeam } from './components/cockpit/team/useTeam';
import { unclaimedRed } from './lib/team';
import { useMissions } from './lib/missions';
import { UndoSheet } from './components/cockpit/UndoSheet';
import { WhatBrokeItSheet } from './components/cockpit/WhatBrokeItSheet';
import { panesSharingFolder } from './components/cockpit/history-model';
import { ProjectMemory } from './components/cockpit/ProjectMemory';
import { Sidebar } from './components/cockpit/Sidebar';
import { HandOverSheet } from './components/cockpit/HandOverSheet';
import { TaskMainView } from './components/cockpit/TaskMainView';
import type { WhereProps } from './components/devices/NewAgentWhere';
import { remoteId, type Device } from './lib/devices';
import { ConnectedBanner } from './components/devices/ConnectedBanner';
import { FarPane } from './components/devices/FarPane';
import { FarGone } from './components/devices/FarGone';
import { useFarRowGone } from './components/devices/useFarRowGone';
import { OPEN_REMOTE_EVENT } from './lib/moveChat';
import { focusDeviceGroup } from './lib/openDevice';
import { useDeviceGroups, type RemoteRow } from './components/devices/useDeviceGroups';
import { CompanionAssist } from './components/cockpit/companion/CompanionAssist';
import { paneHeading } from './components/cockpit/titles';
import { activityText } from './lib/pane-activity';
import { tauri } from './lib/tauri';
import { NUDGE_TEXT } from './lib/potatoCheck';
import { UsageBar } from './components/cockpit/UsageBar';
import { StartupCheckLine } from './components/cockpit/StartupCheckLine';
import { ProblemsChip } from './components/cockpit/problems/ProblemsChip';
import { useNeedsProblemFeed } from './lib/problems-feed';
import { SettingsView } from './components/cockpit/SettingsView';
import { AppUpdateHost } from './components/updates/AppUpdateHost';
import { FeatureGuide } from './components/whatsnew/FeatureGuide';
import { OPEN_GUIDE_EVENT, OPEN_SHORTCUTS_EVENT, OPEN_VIEW_EVENT } from './whatsnew/store';
import { PlansMonth } from './components/cockpit/PlansMonth';
import { MorningPage } from './components/cockpit/night/MorningPage';
import { RoutinesPage } from './components/cockpit/routines/RoutinesPage';
import { useRoutineNotices } from './lib/routines';
import { AgentScores } from './components/cockpit/AgentScores';
import { ReviewDesk } from './components/cockpit/review/ReviewDesk';
import { ReviewDetail } from './components/cockpit/review/ReviewDetail';
import { StoreHost } from './components/store/StoreHost';
import { runStoreCheck } from './lib/agentStoreCheck';
import { useInlineSettings } from './hooks/useInlineSettings';
import { SpawnView } from './components/cockpit/SpawnView';
import { ChatStartingView } from './components/cockpit/ChatStartingView';
import { PanicSheet } from './components/cockpit/PanicSheet';
import { ControlAskNotice } from './components/cockpit/ControlAskNotice';
import { FullAskNotice } from './components/devices/FullAskNotice';
import { DeskAwayChip, DeskAwayHost } from './components/cockpit/DeskAway';
import { IndividualSheet } from './components/cockpit/IndividualSheet';
import { TellTeamToast } from './components/cockpit/team/TellTeam';
import { SimpleCockpit } from './components/simple/SimpleCockpit';
import { FirstRun } from './components/firstrun/FirstRun';
import { useFirstRun } from './components/firstrun/useFirstRun';
import { FinishSetupChip } from './components/firstrun/FinishSetupChip';
import { useSimpleMode } from './lib/simple-mode';
import { projectOfCwd } from './lib/ship-model';
import { useModeSwitch } from './lib/mode-switch/useModeSwitch';
import { LoopGuardContext, tauriLoopApi, useLoopSignals, type StopReport } from './lib/loop-guard';
import { homeView, isSplitShortcut, splitAfterSelect, splitFits, splitMoveKey, splitPartner, splitStillOn, SPLIT_DEFAULT_RATIO, viewAfterSelect, type MainView } from './components/cockpit/main-view';
import { NO_BELOW, belowAfterSelect, canSplitDown, closeSlot, columnOf, downPartner, hasLayout, isDownSlot, moveSlot, sanitizeBelow, shownIds, slotIds, splitColumnDown, type SplitBelow, type SplitColumn, type SplitSlot } from './components/cockpit/split-grid';
import { digitForAction, isMacPlatform, isShortcutRecording, matchesAction } from './lib/shortcuts';
import { useT } from './i18n';
import { setFocusMode, toggleFocusMode, useFocusMode } from './lib/focus-mode';
import { SIDE_MAX, SIDE_MIN, resetSideWidth, saveWidths, setSideWidth, useLayout } from './lib/panel-widths';
import { ResizeHandle } from './components/cockpit/ResizeHandle';
import { nextNeedingPane, paneAtNumber, recordPaneUse, stepPane } from './lib/pane-order';
import { useKeybindingsSync, useKeybindingsVersion } from './hooks/useKeybindings';
import { DragLayer } from './components/dnd/DragLayer';
import { WorkAreaDrop } from './components/dnd/WorkAreaDrop';
import { layoutOfPlan, planDrop, slotOfPlan, type WorkDropColumn, type WorkDropZone } from './components/dnd/work-drop';
import { HelpersBar } from './components/cockpit/HelpersBar';
import { focusSideComposer, SplitView, useWindowWidth } from './components/cockpit/SplitView';
import { useSessionMemory } from './components/cockpit/useSessionMemory';
import { EndedAgentsLine } from './components/cockpit/EndedAgentsLine';
import { UndoBar } from './components/cockpit/UndoBar';
import { useGettingStartedWatch } from './components/cockpit/newagent/useGettingStartedWatch';
import { GETTING_STARTED_EVENT, type GettingStartedAction } from './lib/getting-started';
import { offerCarryOn } from './lib/stop-undo';
import { isReopenChatKey, reopenLastClosedChat } from './lib/reopen-closed';
import { clearSplitMemory, readSplitMemory, restorableSplit, writeSplitMemory, type SplitMemory } from './components/cockpit/split-memory';
import { useYesterdaySnapshot } from './components/cockpit/useYesterdaySnapshot';
import { useCompanions } from './hooks/useCompanions';
import { tauriCompanionTransport } from './lib/companion';

import { checkpointsApiFor, cockpitApi } from './lib/cockpit-api';
import { isFarKey, placeKey } from './lib/host/placeKey';
import { useTabWindowRestore } from './lib/tab-windows';

import { CompanionPage } from './components/cockpit/companion/CompanionPage';
import { isListedAgentPane, isMinionPane } from './lib/pane-helpers';
import { COMPANION_PANE_PREFIX, defaultCompanion, isCompanionPaneId } from './components/cockpit/companion/model';
import { CompanionSetupSheet } from './components/cockpit/companion/CompanionSetupSheet';
import { NewAgentHost } from './components/cockpit/newagent/NewAgentHost';
import { START_CREW_EVENT } from './lib/startCrewEvent';
import { StartCrewSheet } from './components/cockpit/crews/StartCrewSheet';
import { ShortcutsSheet } from './components/cockpit/ShortcutsSheet';
import { ImportHost } from './components/history/ImportHost';
import { AddAgentActionHost } from './components/cockpit/AddAgentActionHost';
import { isTypingTarget } from './components/cockpit/rail/useRailLayout';
import { agentLabel, useAgentRegistry } from './lib/agentRegistry';
import { openSignInAgain } from './lib/agentSignIn';
import { SignInAgainHost } from './components/signin/SignInAgainHost';
import { LiveBar } from './components/cockpit/live/LiveBar';
import { GoLiveSheet } from './components/cockpit/live/GoLiveSheet';
import { LiveStatusContext, useLiveRoom } from './components/cockpit/live/useLiveRoom';
import { useTeamRelay } from './components/cockpit/live/useTeamRelay';
import { sharePanes } from './components/cockpit/live/sharePanes';
import { useLiveStopToast } from './components/cockpit/live/stopToast';
import { GO_LIVE_EVENT } from './lib/live-room';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import './styles/cockpit.css';
import './styles/chips.css';
import './styles/night.css';
import { farChatRows } from './lib/host/farChats';
import { farAgentName } from './lib/host/farCockpit';
import { FarInstallHost } from './components/devices/FarInstallHost';
import { registerNewAgentOpener } from './lib/newAgentRequest';
import { registerSettingsOpener } from './lib/openSettingsAt';
import { SpacesPage } from './components/spaces/SpacesPage';
import { TodayPage, defaultAgentName } from './components/timeline/TodayPage';
import { useTimelineEnabled } from './lib/timeline';
import { AgentBoard } from './components/cockpit/board/AgentBoard';
import { useSpacesEnabled } from './lib/spaces';
import { useLend } from './components/lend/useLend';
import { ConnectPage } from './components/connect/ConnectPage';
import { registerConnectOpener, connectTabFor, rememberedConnectTab, type ConnectTab } from './lib/openConnect';
import { CockpitJoinLink } from './components/team-page/CockpitJoinLink';
import { PassTaskHost } from './components/team-page/PassTaskHost';
import { useTeamPresenceReport } from './components/team-page/useTeamPresenceReport';
import { sidebarCount } from './components/team-page/team-page-model';
import { useRestoreLastChat } from './hooks/useRestoreLastChat';
import { useLendEndedNotice, useLendToasts } from './components/lend/Borrowed';
import { useKeepLentFar } from './components/lend/useKeepLentFar';
import { usageFarOf } from './components/lend/LentChip';
import { useOpenedStandbyPanes, useStandbyFeed } from './lib/standbyHelpers';
import { rootPaneId } from './components/cockpit/helpers-bar-model';
import { AddHelperPopover } from './components/cockpit/AddHelperPopover';
import './styles/night-morning.css';
import './styles/cockpit-routines.css';
import './styles/night-chip.css';
import './styles/cockpit-board.css';

import { deviceLocation } from './lib/projectLocation';
import { loadRemotePanes } from './lib/remotePanes';

export type { MainView } from './components/cockpit/main-view';

/** True inside a pane's terminal, where `?` is typed text. */
const inTerminal = (target: EventTarget | null): boolean => target instanceof Element && target.closest('.terminal-host, .pm-canvas-terminal') !== null;

export default function CockpitApp() {
  useStandbyFeed();
  const c = useCockpit();
  useTabWindowRestore();
  // Comfort (Settings > Look and feel): text size, contrast, less motion, and spoken results.
  useComfortRoot();
  useSpeakFinished(useAttention());
  // The person's own shortcuts (Settings > Shortcuts) for every handler and hint in this window.
  useKeybindingsSync();
  useKeybindingsVersion();
  // Warm agents (Settings > Preload) follow the folder of the focused pane, a moment after it is focused.
  useFollowFocusedProject(c.selectedId ? projectOfCwd(c.registry.panes.get(c.selectedId)?.info.cwd)?.path : null);
  // The agent browser in the side panel (Labs): keeps Rust told where the pane's page is, and opens the pane (in the chat in
  // front) when an agent opens a page.
  const frontChat = useRef<string | null>(null);
  frontChat.current = c.selectedId;
  useEffect(
    () =>
      startDockBrowserBridge((pane) => {
        const id = frontChat.current ?? pane;
        if (id) openBrowserPane(id, { expand: true });
      }),
    [],
  );
  // Chats that run on an SSH machine (the backend keeps them across a window reload): they must never be taken for local ones.
  useEffect(() => {
    void loadRemotePanes();
  }, []);
  const spacesOn = useSpacesEnabled();
  // The Today page (Labs `timeline_day_enabled`): one line for the whole day, and a way back to any point on it.
  const todayOn = useTimelineEnabled();
  // Devices (Labs): the other PCs' groups in the sidebar, and the chat or terminal of one of them in the main area.
  const deviceGroups = useDeviceGroups();
  const farHosts = useFarHosts(deviceGroups.view?.devices ?? []);
  // Connect > Devices > Open: that PC's section in the sidebar is unfolded and scrolled to, and false is answered so the PC's own sheet opens too:
  // the unfolding alone showed nothing when the section was already open, so Open always has a visible result.
  const openPcInSidebar = (node: string): boolean => {
    if (deviceGroups.groups.some((g) => g.device.node === node)) focusDeviceGroup(node);
    return false;
  };
  const [remoteRow, setRemoteRow] = useState<RemoteRow | null>(null);
  const farRowEnded = useFarRowGone(deviceGroups, remoteRow);
  const where: WhereProps | undefined = deviceGroups.enabled
    ? {
        view: deviceGroups.view,
        onAddDevice: () => openConnectPage('devices'),
        onStartedHere: (paneId: string) => c.select(paneId),
        onStarted: (device: Device, paneId: string, chat: boolean) => {
          deviceGroups.refresh();
          setRemoteRow({ key: remoteId(device.node, paneId), node: device.node, paneId, title: '', agent: '', status: 'idle', cwd: '', project: '', chat, location: deviceLocation(device.node, device.name) });
          setView('device');
        },
      }
    : undefined;
  // "Open it there" under a chat that moved to another device: show that chat.
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ node: string; paneId: string }>).detail;
      if (!d?.node || !d.paneId) return;
      deviceGroups.refresh();
      setRemoteRow({ key: remoteId(d.node, d.paneId), node: d.node, paneId: d.paneId, title: '', agent: '', status: 'idle', cwd: '', project: '', chat: true, location: deviceLocation(d.node, '') });
      setView('device');
    };
    window.addEventListener(OPEN_REMOTE_EVENT, open);
    return () => window.removeEventListener(OPEN_REMOTE_EVENT, open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Ctrl+Shift+F opens the palette in "Search all chats"; Ctrl+K in its commands.
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  // The one thing the main area shows (see main-view.ts): the last click wins.
  // The project the New agent page starts with (from a project's "+"); null: the page picks its own.
  const [newAgentProject, setNewAgentProject] = useState<{ path: string; name: string; node?: string } | null>(null);
  const [view, setView] = useState<MainView>(() => homeView(c.spawn !== null, c.selectedId));
  const watchNode = view === 'device' ? (remoteRow?.node ?? null) : null;
  useEffect(() => deviceGroups.watch(watchNode), [watchNode]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new selection or spawn state (a pane closing, an agent starting, a digest opening a pane)
  // returns to the resting view. Done while rendering, so no frame shows a stale view.
  const [seen, setSeen] = useState({ spawn: c.spawn, selectedId: c.selectedId, chatStarting: c.chatStarting !== null });
  const [companionId, setCompanionId] = useState<string | null>(null);
  // A background task the person put in the sidebar, opened in the main area (view 'task').
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [inboxVisit, setInboxVisit] = useState(0);
  // A chat starting (its skeleton) also returns the main area to its resting view, so an open overlay does not hide it.
  const chatStartingNow = c.chatStarting !== null;
  if (seen.spawn !== c.spawn || seen.selectedId !== c.selectedId || seen.chatStarting !== chatStartingNow) {
    setSeen({ spawn: c.spawn, selectedId: c.selectedId, chatStarting: chatStartingNow });
    // A companion's pane closes and starts again by itself (a move, a restart, a nap). Whoever was looking at it
    // lands back on the companion's page, not on the Inbox.
    const lostCompanionPane = c.spawn === null && c.selectedId === null && seen.selectedId !== null && isCompanionPaneId(seen.selectedId);
    if (lostCompanionPane) {
      setCompanionId(seen.selectedId!.slice(COMPANION_PANE_PREFIX.length));
      setView('companion');
    } else {
      setView(homeView(c.spawn !== null, c.selectedId));
    }
  }
  // The split view (main-view.ts): the pane on the right, and which side has focus. The left side is the selected pane.
  const [split, setSplit] = useState<string | null>(null);
  const [side, setSide] = useState<SplitSlot>('left');
  // Up to two more chats below the top two (split-grid.ts): a 2x2 grid. Remembered with the split.
  const [below, setBelow] = useState<SplitBelow>(NO_BELOW);
  // The left side's share of the room (drag or arrow keys on the divider). Remembered with the split (split-memory.ts).
  const [ratio, setRatio] = useState(SPLIT_DEFAULT_RATIO);
  const width = useWindowWidth();
  const t = useT();
  // The window title names what is open ("Inbox — Potato Workspace"), so a window list and a screen reader tell the windows apart.
  const pageName = view === 'inbox' ? t('sidebar.inbox') : view === 'settings' ? t('sidebar.settings') : view === 'connect' ? t('connect.title') : view === 'newagent' ? t('sidebar.newAgent') : view === 'scores' ? t('sidebar.scores') : view === 'plans' ? t('r21.plans.title') : view === 'routines' ? t('sidebar.routines') : view === 'spaces' ? t('sidebar.spaces') : view === 'doctor' ? t('r21.doc.title') : view === 'review' ? t('sidebar.review') : view === 'today' ? t('sidebar.today') : view === 'pane' && c.selectedId ? ((p) => (p ? paneHeading(p.info, c.names.get(c.selectedId!) ?? p.info.agent_type).primary : c.names.get(c.selectedId!)))(c.registry.panes.get(c.selectedId)) : undefined;
  useEffect(() => {
    document.title = pageName ? `${pageName} — Potato Workspace` : 'Potato Workspace';
  }, [pageName]);
  const focusMode = useFocusMode();
  const layout = useLayout();
  // The chats the keys and the split view step through: no minion runs and no standby chats, except one the person opened.
  const openedStandbyPanes = useOpenedStandbyPanes();
  const paneIds = c.registry.paneList.filter((p) => isListedAgentPane(p.info, openedStandbyPanes)).map((p) => p.info.id);
  // A routine or chain says something (a "tell me" step, a failure, a pause): show it as a notice.
  useRoutineNotices(c.notify);
  // The animated Orchestration <-> Individual switch: Rust asks for the proxies, this window fades around the overlay.
  useModeSwitch({
    activeId: c.selectedId,
    describe: (id) => {
      const p = c.registry.panes.get(id);
      return { name: c.names.get(id) ?? p?.info.agent_type ?? id, project: projectOfCwd(p?.info.cwd)?.name ?? '', status: p?.status ?? 'idle' };
    },
  });
  const splitOn = splitStillOn(split, { selectedId: c.selectedId, width, hasPane: (id) => c.registry.panes.has(id) });
  // The split turns off by itself when its pane closes, the selection goes away, or the window gets narrow.
  if (split !== null && !splitOn) setSplit(null);
  // The chats below only show while the split is on, and a chat that is gone (or shown twice) drops out of the grid.
  const belowNow = splitOn && split !== null && c.selectedId !== null ? sanitizeBelow(below, c.selectedId, split, (id) => c.registry.panes.has(id)) : NO_BELOW;
  if (split === null && hasLayout(below)) setBelow(NO_BELOW);
  // The Review Desk: `reviewFirst` opens it on its first row ("Review the riskiest item" in the palette).
  const [reviewFirst, setReviewFirst] = useState(false);
  const openReview = (first = false) => {
    setReviewFirst(first);
    setView('review');
  };
  const closeOverlay = () => setView(homeView(c.spawn !== null, c.selectedId));
  // Connect: the phone, other PCs, the team and lending. It opens on the tab last used.
  const [connectTab, setConnectTab] = useState<ConnectTab>(rememberedConnectTab);
  const openConnectPage = (tab?: ConnectTab) => {
    if (tab) setConnectTab(tab);
    setView('connect');
  };
  // The Agent Store: opened from the "+" menu, the palette, Set up agents and Settings > Agents. Back returns to the resting view.
  const openStore = () => setView('store');
  // Settings is a main view in Orchestration mode; in Individual mode `open` asks for the Settings window.
  const settings = useInlineSettings<MainView>({ mode: c.mode, view, setView, home: homeView(c.spawn !== null, c.selectedId), openWindow: c.openSettings });
  // Pane whose last turn the person is being asked to undo (opened from the palette).
  const [undoPane, setUndoPane] = useState<string | null>(null);
  const undoHost = undoPane && isFarKey(undoPane) ? farHosts.find((h) => h.place.kind === 'pc' && undoPane.startsWith(placeKey(h.place, ''))) : undefined;
  const undoApi = useMemo(() => (undoHost ? checkpointsApiFor(undoHost) : cockpitApi), [undoHost]);
  // Pane whose "What broke the tests?" sheet is open (from History or the palette).
  const [whatBrokePane, setWhatBrokePane] = useState<string | null>(null);
  const loop = useLoopSignals();
  // Companions (SPEC section 8): the sidebar rows, the page that opens from one, and the setup sheet. Without a
  // companion backend the list is null and the palette and sidebar show no companion entries.
  const companions = useCompanions();
  const [setupOpen, setSetupOpen] = useState(false);
  // Tray (cockpit://view): "Open Inbox" shows the Inbox.
  // The ref keeps the listener subscribed once while always calling the latest handlers.
  const viewHandlers = useRef({ select: c.select });
  viewHandlers.current = { select: c.select };
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void cockpitApi
      .onView((e) => {
        if (e.view === 'inbox') {
          viewHandlers.current.select(null);
          setView('inbox');
          setInboxVisit((n) => n + 1);
        } else if (e.view === 'newagent') {
          setNewAgentProject(null);
          setView('newagent');
        }
      })
      .then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // "Start crew…" (crews): pick a saved team and a folder.
  const [crewOpen, setCrewOpen] = useState(false);
  // The crew canvas's "Start this crew…" asks for the same sheet.
  useEffect(() => {
    const open = () => setCrewOpen(true);
    window.addEventListener(START_CREW_EVENT, open);
    return () => window.removeEventListener(START_CREW_EVENT, open);
  }, []);
  // The keyboard shortcuts sheet: `?`, Ctrl+/, or "Keyboard shortcuts" in the palette.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const agentListing = useAgentRegistry();
  // Live Room: one status for the bar, the pane chips and the palette. The Go live sheet opens on an event the chat
  // menu and the palette fire. The stop toast says why a room ended, whoever ended it.
  const live = useLiveRoom();
  const [goLive, setGoLive] = useState<{ paneId: string | null } | null>(null);
  const teamRelay = useTeamRelay(goLive !== null);
  useLiveStopToast(live.status, c.notify);
  useEffect(() => {
    const onGoLive = (e: Event) => {
      if (live.status?.live) {
        c.notify('Live Room is already running. Stop it first.');
        return;
      }
      setGoLive({ paneId: (e as CustomEvent<{ paneId: string | null }>).detail?.paneId ?? null });
    };
    window.addEventListener(GO_LIVE_EVENT, onGoLive);
    return () => window.removeEventListener(GO_LIVE_EVENT, onGoLive);
  });
  const companion = companions.companions?.find((x) => x.id === companionId) ?? null;
  const openCompanion = (id: string) => {
    setCompanionId(id);
    setView('companion');
  };
  const [stopReport, setStopReport] = useState<StopReport | null>(null);
  // A stop shows the report sheet and, for anything that was stopped, the undo bar (Undo = ask them to carry on).
  const showStopReport = (report: StopReport) => {
    setStopReport(report);
    offerCarryOn(report);
  };
  const showStopReportRef = useRef(showStopReport);
  showStopReportRef.current = showStopReport;
  const stopAll = () => {
    tauriLoopApi
      .stopAll()
      .then(showStopReport)
      .catch(() => c.notify('Could not stop the agents'));
  };
  // Tray item and global shortcut stop the agents in Rust and send the result here.
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    tauriLoopApi
      .onPanic((report) => showStopReportRef.current(report))
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  // Cards and buttons that say "Open Settings" on a row (openSettingsAt) open it through here: a row id is a valid tab.
  useEffect(() => {
    // Phone, Devices, Team and Lend moved to the Connect page: an old target for one of them opens its tab.
    registerSettingsOpener((tab) => {
      const to = connectTabFor(tab);
      if (to) openConnectPage(to);
      else void settings.open(tab);
    });
    return () => registerSettingsOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.open]);
  useEffect(() => {
    registerConnectOpener((tab) => openConnectPage(tab));
    return () => registerConnectOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A ready lend says "Start a chat": the New agent page (no project picked).
  useEffect(() => {
    registerNewAgentOpener(() => {
      setNewAgentProject(null);
      setView('newagent');
    });
    return () => registerNewAgentOpener(null);
  }, [settings.open]);
  // Any selection (a pane, the inbox), even of the already-selected pane, leaves the
  // "Set up agents" and "Project memory" views.
  const nav: typeof c = {
    ...c,
    openSettings: async (tab) => {
      const to = connectTabFor(tab);
      if (to) openConnectPage(to);
      else settings.open(tab);
    },
    select: (id) => {
      setView(viewAfterSelect(c.spawn, id));
      setSplit((s) => splitAfterSelect(s, c.selectedId, id));
      setBelow((b) => belowAfterSelect(b, c.selectedId, id));
      setSide('left');
      c.select(id);
    },
  };
  // "Handoff from here": the sidebar's row menu and the pane's "Hand off" button share one (it opens the new agent through nav).
  const handoff = useHandoff(nav);
  // A mark-up sent from the agent browser becomes one "Marked up" card in the chat (see lib/markupCard.ts).
  useMarkupSendRecorder();
  // The crew canvas's Live tab opens a helper like the crew chip does: a minion as the read-only view in its parent's chat, any other as a chat.
  const navRef = useRef(nav);
  navRef.current = nav;
  const panesRef = useRef(c.registry.paneList);
  panesRef.current = c.registry.paneList;
  useEffect(() => {
    const open = (e: Event) => {
      // Only an id the cockpit lists is acted on, and the parent is the pane's own recorded one (never the event's).
      const d = (e as CustomEvent<{ id?: string }>).detail;
      const pane = typeof d?.id === 'string' ? panesRef.current.find((p) => p.info.id === d.id) : undefined;
      if (!pane) return;
      const parent = pane.info.parent_pane_id;
      if (isMinionPane(pane.info) && parent && panesRef.current.some((p) => p.info.id === parent)) {
        openMinionView(parent, pane.info.id);
        navRef.current.select(parent);
      } else if (!isMinionPane(pane.info)) navRef.current.select(pane.info.id);
    };
    window.addEventListener(OPEN_HELPER_EVENT, open);
    return () => window.removeEventListener(OPEN_HELPER_EVENT, open);
  }, []);
  // Ctrl+\: split with the pane above (or below) the selected one; again closes it.
  const toggleSplit = () => {
    if (split !== null) {
      setSplit(null);
      setSide('left');
      return;
    }
    if (!splitFits(width)) return;
    if (c.selectedId === null) {
      c.notify('Pick an agent first to split the view');
      return;
    }
    const partner = splitPartner(paneIds, c.selectedId);
    if (partner === null) {
      c.notify('Open a second agent to split the view');
      return;
    }
    setView('pane');
    setSplit(partner);
    setSide('left');
  };
  // Split down: another chat opens below a column (the next one in the list that is not on screen). Up to four chats.
  const splitDownFrom = (column: SplitColumn) => {
    if (c.selectedId === null || split === null) return;
    const shown = shownIds(c.selectedId, split, belowNow);
    if (shown.length >= 4) {
      c.notify(t('split.full'));
      return;
    }
    const col = canSplitDown(belowNow, column, shown.length) ? column : column === 'left' ? 'right' : 'left';
    const partner = downPartner(paneIds.filter((id) => !isCompanionPaneId(id)), shown, col === 'left' ? c.selectedId : split);
    if (partner === null || !canSplitDown(belowNow, col, shown.length)) {
      c.notify(t('split.needAnother'));
      return;
    }
    setBelow(splitColumnDown(belowNow, col, partner));
    setSide(col === 'left' ? 'leftDown' : 'rightDown');
  };
  // Takes one chat out of the split view (its agent keeps running). The grid closes up; one chat left ends the split.
  const closeChatSlot = (slot: SplitSlot) => {
    if (c.selectedId === null || split === null) return;
    const next = closeSlot({ left: c.selectedId, right: split, below: belowNow }, slot);
    if (next.left !== c.selectedId) c.select(next.left);
    setSide('left');
    if (next.right === null) {
      setSplit(null);
      setBelow(NO_BELOW);
      return;
    }
    setSplit(next.right);
    setBelow(next.below);
  };
  // "Open to the side" in a pane row's menu: the row's pane goes on the right, the selected one stays left.
  const openToSide = (id: string) => {
    if (!splitFits(width)) {
      c.notify('The window is too narrow for two chats');
      return;
    }
    if (c.selectedId === null) {
      nav.select(id);
      return;
    }
    if (id === c.selectedId || id === split) {
      c.notify(t('split.alreadyOpen'));
      return;
    }
    setView('pane');
    setSplit(id);
    setSide('left');
  };
  // The Getting started card: it ticks itself from what happens here, and its buttons ask this window to do the thing.
  useGettingStartedWatch({ ready: c.registry.initialReady, agentCount: paneIds.filter((id) => !isCompanionPaneId(id)).length, splitOn });
  useEffect(() => {
    const onAsk = (e: Event) => {
      const action = (e as CustomEvent<{ action: GettingStartedAction }>).detail?.action;
      if (action === 'review') openReview();
      else if (action === 'undo') {
        setPaletteMode('commands');
        setPaletteOpen(true);
      } else if (action === 'side') {
        const ids = paneIds.filter((id) => !isCompanionPaneId(id));
        if (ids.length < 2) c.notify(t('gs.side.needTwo'));
        else if (!splitFits(width)) c.notify('The window is too narrow for two chats');
        else {
          nav.select(ids[0]);
          setView('pane');
          setSplit(ids[1]);
          setSide('left');
        }
      }
    };
    window.addEventListener(GETTING_STARTED_EVENT, onAsk);
    return () => window.removeEventListener(GETTING_STARTED_EVENT, onAsk);
  });
  // The chats on screen, and the one with the focus (a split's focused side): the helpers bar follows it.
  const shownNow = splitOn && split !== null && c.selectedId !== null ? shownIds(c.selectedId, split, belowNow) : c.selectedId !== null ? [c.selectedId] : [];
  const focusedPane = splitOn && split !== null && c.selectedId !== null ? (slotIds(c.selectedId, split, belowNow)[side] ?? c.selectedId) : c.selectedId;
  // `standby.new` (What's new "Try it") adds a helper under the agent in front (its main agent when a helper is in front).
  const frontRoot = focusedPane ? rootPaneId(c.registry.paneList, focusedPane) : null;
  const frontInfo = frontRoot ? c.registry.paneList.find((p) => p.info.id === frontRoot)?.info : undefined;
  const frontForHelper = frontInfo ? { id: frontInfo.id, cwd: frontInfo.cwd ?? null, agent: frontInfo.agent_type } : null;
  // The chat that was in front before: it comes up beside a dragged chat that was the only one open.
  const recentRef = useRef<string[]>([]);
  useEffect(() => {
    if (c.selectedId) recentRef.current = [c.selectedId, ...recentRef.current.filter((x) => x !== c.selectedId)].slice(0, 20);
  }, [c.selectedId]);
  const partnerFor = (id: string): string | null => {
    const ok = (p: string) => p !== id && c.registry.panes.has(p) && !isCompanionPaneId(p);
    return recentRef.current.find(ok) ?? paneIds.find(ok) ?? null;
  };
  const titleOfPane = (id: string) => {
    const p = c.registry.panes.get(id);
    return p ? paneHeading(p.info, c.names.get(id) ?? p.info.agent_type).primary : id;
  };
  // A chat dropped on the work area (components/dnd/work-drop.ts says where it lands). Also the keyboard way: the
  // row menu's "Open on the left" / "Open below".
  const dropChat = (id: string, zone: WorkDropZone, column: WorkDropColumn = 'right') => {
    if (!splitFits(width)) {
      c.notify('The window is too narrow for two chats');
      return;
    }
    const plan = planDrop({ shown: shownNow, id, zone, column, remembered: ratio, partner: partnerFor(id) });
    setView('pane');
    const next = layoutOfPlan(plan);
    if (next.split === null) {
      nav.select(next.selected);
      return;
    }
    if (next.selected !== c.selectedId) c.select(next.selected);
    setSplit(next.split);
    setBelow(next.below);
    if (plan.ratio !== null) setRatio(plan.ratio);
    setSide(slotOfPlan(plan, id));
  };
  // A click on a helper chip or the crumb opens that agent in the focused pane (a pane that is already open takes the focus).
  const openInFocused = (id: string) => {
    setView('pane');
    if (!splitOn || split === null || c.selectedId === null) {
      nav.select(id);
      return;
    }
    const slots = slotIds(c.selectedId, split, belowNow);
    const at = (Object.keys(slots) as SplitSlot[]).find((s) => slots[s] === id);
    if (at) {
      setSide(at);
      return;
    }
    if (side === 'left') c.select(id);
    else if (side === 'right') setSplit(id);
    else setBelow((b) => (side === 'leftDown' ? { ...b, leftDown: id } : { ...b, rightDown: id }));
  };
  useEffect(() => {
    if (c.registry.paneList.length > 0) markSpawned();
  }, [c.registry.paneList.length]);
  const away = useAway(c.registry.paneList.map((p) => p.info.id));
  // The first-run welcome: once on a fresh profile, again from the palette or Settings.
  const welcome = useFirstRun(c.registry.paneList.length, c.registry.initialReady);
  // One welcome: the Inbox's "Set up your agents" opens the first-run flow until it was finished or
  // skipped (Set up agents after), and while the flow is on screen the Inbox offers no second way in.
  const welcomeShown = welcome.open && c.mode !== 'individual';
  const welcomeSetUp = welcomeShown ? null : !welcome.done && c.mode !== 'individual' ? welcome.resume : () => setView('doctor');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (matchesAction(e, 'palette')) {
        e.preventDefault();
        setPaletteMode('commands');
        setPaletteOpen((v) => !v);
      } else if (matchesAction(e, 'search-chats')) {
        e.preventDefault();
        setPaletteMode('chats');
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // `?` (not while typing in a box or a terminal) or Ctrl+/ (Cmd+/ on a Mac, or your own keys) opens the keyboard shortcuts sheet.
  // What's new: Help, the palette and "Try it" ask for the Feature guide, the shortcuts sheet, or a main view.
  useEffect(() => {
    const guide = () => setView('guide');
    const shortcuts = () => setShortcutsOpen(true);
    const openView = (e: Event) => {
      const v = (e as CustomEvent<{ view?: string }>).detail?.view;
      if (v === 'inbox') {
        nav.select(null);
        setView('inbox');
        setInboxVisit((n) => n + 1);
      } else if (v === 'guide') setView('guide');
    };
    window.addEventListener(OPEN_GUIDE_EVENT, guide);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, shortcuts);
    window.addEventListener(OPEN_VIEW_EVENT, openView);
    return () => {
      window.removeEventListener(OPEN_GUIDE_EVENT, guide);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, shortcuts);
      window.removeEventListener(OPEN_VIEW_EVENT, openView);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const questionMark = e.key === '?' && !isShortcutRecording() && !e.altKey && !e.ctrlKey && !e.metaKey && !isTypingTarget(e.target) && !inTerminal(e.target);
      const ownKeys = matchesAction(e, 'show-list');
      if (!questionMark && !ownKeys) return;
      e.preventDefault();
      setShortcutsOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Ctrl+Shift+T (Cmd+Shift+T on a Mac, or your own keys) reopens the chat closed last, like a browser tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !isReopenChatKey(e, isMacPlatform())) return;
      if (inTerminal(e.target) || isShortcutRecording()) return;
      e.preventDefault();
      void reopenLastClosedChat(nav.select, c.notify);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Ctrl+N (Cmd+N on a Mac) opens the New agent page. In a terminal the key belongs to the program running there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !matchesAction(e, 'new-agent')) return;
      if (inTerminal(e.target) || c.mode === 'individual') return;
      e.preventDefault();
      setNewAgentProject(null);
      setView('newagent');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [c.mode]);

  // Ctrl+\ (see toggleSplit). Re-listens each render so it always sees the current selection and split.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSplitShortcut(e) || e.isComposing) return;
      // Ctrl+\ is the terminal's quit key (SIGQUIT): the split takes it, so the pane does not get it too.
      e.preventDefault();
      e.stopPropagation();
      toggleSplit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Ctrl+0 (Cmd+0 on a Mac): the agent board. Again closes it. In a terminal the key is left to the program there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !matchesAction(e, 'agent-board')) return;
      if (inTerminal(e.target) || c.mode === 'individual') return;
      e.preventDefault();
      e.stopPropagation();
      setView((v) => (v === 'board' ? homeView(c.spawn !== null, c.selectedId) : 'board'));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [c.mode, c.spawn, c.selectedId]);

  // Focus mode: Ctrl+Shift+Enter fills the window with the open pane; the same keys, Esc (outside a terminal, a menu
  // or a sheet) or the button bring everything back. It also ends by itself when no pane is open.
  const paneOpen = view === 'pane' && c.selectedId !== null;
  useEffect(() => {
    if (!paneOpen) setFocusMode(false);
  }, [paneOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (matchesAction(e, 'focus-mode', isMacPlatform())) {
        if (!paneOpen && !focusMode) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFocusMode();
        return;
      }
      if (e.key !== 'Escape' || !focusMode || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (inTerminal(e.target) || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [paneOpen, focusMode]);

  // Ctrl+Alt+X swaps the two sides of a split view. The pane that had the focus keeps it on its new side.
  useEffect(() => {
    if (split === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || !matchesAction(e, 'split-swap', isMacPlatform())) return;
      e.preventDefault();
      e.stopPropagation();
      const was = side;
      // Picking the right pane makes it the left one and the old left pane the right one (splitAfterSelect).
      nav.select(split);
      setSide(isDownSlot(was) ? was : was === 'left' ? 'right' : 'left');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Ctrl+Alt+Left / Right (Cmd+Alt on a Mac) move the focus between the two sides. Only while the split is open:
  // otherwise the keys go on to the terminal as before.
  // Shift with the same keys moves between the chats above and below each other.
  useEffect(() => {
    if (split === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const dir = splitMoveKey(e, isMacPlatform());
      if (!dir) return;
      const to = moveSlot(side, dir, belowNow) ?? (dir === 'left' || dir === 'right' ? dir : null);
      if (!to) return;
      e.preventDefault();
      e.stopPropagation();
      setSide(to);
      focusSideComposer(to);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Ctrl+Alt+D opens another chat below the focused one (up to four); Ctrl+Alt+W takes the focused chat out of the view.
  useEffect(() => {
    if (split === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const down = matchesAction(e, 'split-down', isMacPlatform());
      if (!down && !matchesAction(e, 'split-close-side', isMacPlatform())) return;
      e.preventDefault();
      e.stopPropagation();
      if (down) splitDownFrom(columnOf(side));
      else closeChatSlot(side);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // The split comes back on start when both of its panes still exist (split-memory.ts). The left pane is selected
  // again too: the app starts with no pane selected. Runs once, when the pane list is first known.
  const session = useSessionMemory({
    ready: c.registry.initialReady,
    selectedId: c.selectedId,
    panes: c.registry.panes,
    select: nav.select,
    newAgent: c.newAgent,
  });
  const restoredSplit = useRef(false);
  useEffect(() => {
    if (!c.registry.initialReady || restoredSplit.current) return;
    restoredSplit.current = true;
    // The pane the last run ended on comes back first (session-memory.ts); a restored split then takes over.
    if (c.selectedId === null && !c.spawn) session.restoreSelection();
    const memory = restorableSplit(readSplitMemory(), { width, hasPane: (id) => c.registry.panes.has(id) });
    if (!memory) return;
    nav.select(memory.left);
    setSplit(memory.right);
    setRatio(memory.ratio);
    setBelow(memory.below ?? NO_BELOW);
    setSide('left');
  }, [c.registry.initialReady]);
  // Saves the split while it is on. A split that ends (closed, the inbox picked, its pane gone, a narrow window)
  // clears the saved one, but only if this window saved one: a start without a restored split leaves storage alone.
  const savedSplit = useRef(false);
  useEffect(() => {
    if (split !== null && c.selectedId !== null) {
      writeSplitMemory(hasLayout(belowNow) ? { left: c.selectedId, right: split, ratio, below: belowNow } : { left: c.selectedId, right: split, ratio });
      savedSplit.current = true;
    } else if (savedSplit.current) {
      clearSplitMemory();
      savedSplit.current = false;
    }
  }, [split, ratio, c.selectedId, belowNow]);

  // "Continue where you left off" (yesterday-memory.ts): this run's open chats are saved for the next start.
  const openPanes = useMemo(() => c.registry.paneList.map((p) => p.info), [c.registry.paneList]);
  const liveSplit = useMemo<SplitMemory | null>(() => (split !== null && c.selectedId !== null ? (hasLayout(belowNow) ? { left: c.selectedId, right: split, ratio, below: belowNow } : { left: c.selectedId, right: split, ratio }) : null), [split, ratio, c.selectedId, belowNow]);
  useYesterdaySnapshot({ ready: c.registry.initialReady, panes: openPanes, split: liveSplit });
  // Chats reopened from that card: the split they had comes back once both of its panes are on the list.
  const [pendingSplit, setPendingSplit] = useState<SplitMemory | null>(null);
  useEffect(() => {
    if (!pendingSplit) return;
    if (!c.registry.panes.has(pendingSplit.left) || !c.registry.panes.has(pendingSplit.right)) return;
    setPendingSplit(null);
    if (!splitFits(width)) return;
    nav.select(pendingSplit.left);
    setSplit(pendingSplit.right);
    setRatio(pendingSplit.ratio);
    setBelow(pendingSplit.below ?? NO_BELOW);
    setSide('left');
  }, [pendingSplit, c.registry.panes]);
  const onReopenedRun = (paneIds: string[], back: SplitMemory | null) => {
    if (back) setPendingSplit(back);
    else if (paneIds[0]) nav.select(paneIds[0]);
  };

  const { onClickCapture } = useNudgeOnAction();
  // Mission cards (Labs) count once in the one list, as they do in the Rust snapshot (tray, phone).
  const missionList = useMissions();
  // War Room: a red default branch nobody claimed counts too (the Rust `team_ci:` item, for tray and phone).
  const team = useTeam();
  const teamRed = useMemo(() => unclaimedRed(team.state), [team.state]);
  // Share an agent (Labs): requests to borrow wait for my yes, borrowed panes get toasts as the time runs out.
  const lend = useLend();
  const lendRequests = useMemo(() => (lend.state?.requests_in ?? []).filter((r) => r.state === 'open'), [lend.state]);
  useLendToasts(lend, c.notify);
  useLendEndedNotice(lend, c.notify);
  // "Use my own agents": a far chat on my lend keeps it rolling.
  // The far chats are keys of their own (`dev:<node>:<id>`), listed by the PC groups, not by this PC's registry.
  useKeepLentFar(lend, useMemo(() => [...c.registry.paneList.map((p) => p.info.id), ...deviceGroups.groups.flatMap((g) => g.rows.map((r) => r.key))], [c.registry.paneList, deviceGroups.groups]));
  // The Team page: what I am doing is told to the team backend (only while Team is on), and the sidebar row counts what waits for me.
  const selectedProject = projectOfCwd(c.selectedId ? c.registry.panes.get(c.selectedId)?.info.cwd : null);
  useTeamPresenceReport(!!team.state?.active, {
    projectName: selectedProject?.name ?? null,
    projectPath: selectedProject?.path ?? null,
    title: c.selectedId ? (c.names.get(c.selectedId) ?? null) : null,
    running: c.registry.paneList.filter((p) => p.status === 'running').length,
    waiting: c.registry.paneList.filter((p) => p.status === 'waiting_input').length,
  });
  const teamWaiting = useMemo(() => sidebarCount(null, lend.state) + (team.state?.cards.filter((x) => x.state === 'new' && (x.event.kind === 'please_review' || x.event.kind === 'review_requested')).length ?? 0), [lend.state, team.state]);
  const assistPanes = useMemo(() => c.registry.paneList.map((p) => ({ id: p.info.id, status: p.status })), [c.registry.paneList]);
  const needsYou = useNeedsYouSource(c, loop.signals, undefined, missionList.missions, companions.companions ?? undefined, teamRed, lendRequests, deviceGroups.questions);
  // Opens a chat of another PC (a search hit, an Inbox card, the palette): false when that PC no longer lists it.
  const openFarChat = (key: string): boolean => {
    const row = deviceGroups.groups.flatMap((g) => g.rows).find((r) => r.key === key);
    if (!row) return false;
    setRemoteRow(row);
    setView('device');
    return true;
  };
  useRestoreLastChat({
    open: view === 'device' ? (remoteRow?.key ?? null) : view === 'pane' ? c.selectedId : null,
    has: (key) => (key.startsWith('dev:') ? deviceGroups.groups.some((g) => g.device.state === 'online' && g.rows.some((r) => r.key === key)) : c.registry.panes.has(key)),
    openChat: (key) => (key.startsWith('dev:') ? openFarChat(key) : (c.select(key), true)),
  });
  const farChats = useMemo(() => farChatRows(deviceGroups.groups, (type) => c.launchEntries.find((e) => e.type === type)?.label ?? farAgentName(type)), [deviceGroups.groups, c.launchEntries]);
  const farNeeds = useMemo<FarNeeds>(() => ({ questions: deviceGroups.questions, chatQuestions: deviceGroups.allQuestions, open: openFarChat, answer: deviceGroups.answerQuestion, hide: deviceGroups.hideQuestion }), [deviceGroups.questions, deviceGroups.allQuestions, deviceGroups.groups, deviceGroups.answerQuestion, deviceGroups.hideQuestion]); // eslint-disable-line react-hooks/exhaustive-deps
  useNeedsProblemFeed(needsYou, {
    nameOf: (id) => c.names.get(id) ?? c.registry.panes.get(id)?.info.agent_type ?? id,
    agentIdOf: (id) => c.registry.panes.get(id)?.info.agent_type ?? null,
  });

  // Which pane was looked at when: the palette lists the most recent first.
  useEffect(() => {
    if (c.selectedId) recordPaneUse(c.selectedId);
  }, [c.selectedId]);

  // Moving between agents from the keyboard: next / previous, jump to number 1 to 9, the next one that needs you, the Inbox.
  // Re-listens each render so it sees the current list. The pane never gets these keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || c.mode === 'individual') return;
      const ids = paneIds.filter((id) => !isCompanionPaneId(id));
      let handled = true;
      const digit = digitForAction(e, 'pane-jump');
      if (digit !== null) {
        const id = paneAtNumber(ids, digit);
        if (id) nav.select(id);
      } else if (matchesAction(e, 'pane-next')) {
        const id = stepPane(ids, c.selectedId, 1);
        if (id) nav.select(id);
      } else if (matchesAction(e, 'pane-prev')) {
        const id = stepPane(ids, c.selectedId, -1);
        if (id) nav.select(id);
      } else if (matchesAction(e, 'next-needs-me')) {
        const waiting = new Set(needsYou.flatMap((item) => (item.paneId ? [item.paneId] : [])));
        const id = nextNeedingPane(ids, waiting, c.selectedId);
        if (id) nav.select(id);
        else c.notify('Nothing needs you right now');
      } else if (matchesAction(e, 'open-inbox')) {
        nav.select(null);
        setView('inbox');
        setInboxVisit((n) => n + 1);
      } else handled = false;
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // Simple mode (Settings > General) swaps the whole face; off by default, so this line does nothing then.
  const simple = useSimpleMode();
  const themeProps = useThemeAttrs(c.theme);
  // While the welcome is open the normal face stays, so its sign-in and install windows are visible.
  if (simple && c.mode !== 'individual' && !welcome.open) {
    return (
      <>
        {/* No face hides the LIVE bar: in Simple mode it sits over the top edge. */}
        <div className="cockpit ck-live-top" {...themeProps}>
          <LiveBar />
        </div>
        <SimpleCockpit c={c} loop={loop} needsYou={needsYou} lastTurn={away.lastTurn} />
      </>
    );
  }

  return (
    <LoopGuardContext.Provider value={loop}>
    <NeedsYouContext.Provider value={needsYou}>
    <FarNeedsContext.Provider value={farNeeds}>
    <LastTurnContext.Provider value={away.lastTurn}>
    <LiveStatusContext.Provider value={live.status}>
    <div
      className="cockpit"
      {...themeProps}
      data-side-strip={layout.strip ? '' : undefined}
      data-settings-open={view === 'settings' ? '' : undefined}
      data-focus-mode={focusMode ? '' : undefined}
      style={{ ['--ck-side-w' as string]: `${layout.sidePx}px` } as CSSProperties}
      onClickCapture={onClickCapture}
    >
      {/* First Tab stop: jumps past the sidebar's ~50 stops to the main area. */}
      <a
        className="ck-skip"
        href="#ck-main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('ck-main')?.focus();
        }}
      >
        {t('r11.skipToContent')}
      </a>
      {!focusMode && (
        <ResizeHandle
          className="ck-resize--side"
          grow="right"
          value={layout.sidePx}
          min={SIDE_MIN}
          max={SIDE_MAX}
          label={t('pane.resizeSidebar')}
          title={t('pane.resizeSidebarTip')}
          onChange={setSideWidth}
          onCommit={saveWidths}
          onReset={resetSideWidth}
        />
      )}
      <Sidebar
        c={nav}
        handoff={handoff}
        onOpenInbox={() => setInboxVisit((n) => n + 1)}
        onOpenPalette={() => {
          setPaletteMode('commands');
          setPaletteOpen(true);
        }}
        onOpenDoctor={() => setView('doctor')}
        onOpenMemory={() => setView('memory')}
        onOpenPlans={() => setView('plans')}
        onOpenMorning={() => setView('morning')}
        onOpenRoutines={() => setView('routines')}
        connect={{ open: view === 'connect', waiting: teamWaiting }}
        onOpenConnect={() => openConnectPage()}
        canPassTask={!!team.state?.active}
        onOpenScores={() => setView('scores')}
        onOpenToday={todayOn ? () => setView('today') : undefined}
        todayOpen={view === 'today' && todayOn}
        onOpenReview={() => openReview()}
        onOpenStore={openStore}
        companions={companions.companions}
        openCompanionId={view === 'companion' ? companionId : null}
        onOpenCompanion={openCompanion}
        openTaskId={view === 'task' ? openTaskId : null}
        onOpenTask={(id) => {
          setOpenTaskId(id);
          setView(id ? 'task' : homeView(c.spawn !== null, c.selectedId));
        }}
        onNewCompanion={() => setSetupOpen(true)}
        onOpenNewAgent={(project) => {
          setNewAgentProject(project ?? null);
          setView('newagent');
        }}
        newAgentOpen={view === 'newagent'}
        settingsOpen={view === 'settings'}
        spaces={{ enabled: spacesOn }}
        devices={
          deviceGroups.enabled
            ? {
                groups: deviceGroups.groups,
                where,
                selectedKey: view === 'device' ? (remoteRow?.key ?? null) : null,
                onRetry: deviceGroups.refresh,
                onOpen: (row) => {
                  setRemoteRow(row);
                  setView('device');
                },
              }
            : undefined
        }
        spacesOpen={view === 'spaces' && spacesOn}
        onOpenSpaces={() => setView('spaces')}
        onOpenToSide={openToSide}
        onOpenPlaced={(id, where) => dropChat(id, where)}
        onPaneAction={(id, action) => {
          // The actions run in a pane's own view: a split view gives way to it.
          setSplit(null);
          nav.select(id);
          requestPaneAction(id, action);
        }}
      />
      <main className="ck-main" id="ck-main" tabIndex={-1}>
        <ConnectedBanner view={deviceGroups.view} onDone={deviceGroups.refresh} />
        <EndedAgentsLine ended={session.ended} onReopen={session.reopen} onDismiss={session.dismiss} />
        <AddHelperPopover front={frontForHelper} homeLabel={(id) => {
          const p = c.registry.paneList.find((x) => x.info.id === id);
          return p ? paneHeading(p.info, nav.names.get(id) ?? p.info.agent_type).primary : id;
        }} />
        {view === 'pane' && focusedPane && c.mode !== 'individual' && <HelpersBar c={nav} focusedId={focusedPane} shown={shownNow} onOpen={openInFocused} onOpenBeside={openToSide} />}
        {c.mode === 'individual' ? (
          <div className="ck-spawn ck-spawn--plain">
            <h1 className="ck-title">Individual mode</h1>
            <p className="ck-sub">Panes are in their own windows.</p>
            <button type="button" className="ck-btn ck-btn--secondary" onClick={() => void c.setMode('orchestration')}>
              Switch to Orchestration
            </button>
          </div>
        ) : view === 'doctor' ? (
          <AgentDoctor
            onOpenAgent={(id) => void c.newAgent(id)}
            onNotify={c.notify}
            onShowPane={(id) => nav.select(id)}
            onClose={closeOverlay}
            onOpenStore={openStore}
          />
        ) : view === 'store' ? (
          <StoreHost onOpenAgent={(id) => void c.newAgent(id)} onBack={closeOverlay} runCheck={runStoreCheck} />
        ) : view === 'memory' ? (
          <ProjectMemory
            // A pane in a separate copy belongs to the project the copy came from, not to the copy's folder.
            project={c.selectedId ? projectOfCwd(c.registry.panes.get(c.selectedId)?.info.cwd)?.path : undefined}
            onClose={closeOverlay}
          />
        ) : view === 'plans' ? (
          <PlansMonth onClose={closeOverlay} />
        ) : view === 'morning' ? (
          <MorningPage onClose={closeOverlay} onOpenPane={(id) => nav.select(id)} />
        ) : view === 'guide' ? (
          <div className="wn-page">
            <FeatureGuide notify={c.notify} />
          </div>
        ) : view === 'connect' ? (
          // The page is taller than a small window and .ck-main does not scroll, so this wrapper does (Settings did it before Connect moved here).
          <div className="ck-connect-scroll" data-testid="connect-scroll">
            <ConnectPage tab={connectTab} onTab={setConnectTab} team={team} lend={lend} paneNames={c.names} onOpenPc={openPcInSidebar} onOpenPane={(paneId) => nav.select(paneId)} />
          </div>
        ) : view === 'routines' ? (
          <RoutinesPage onClose={closeOverlay} defaultProject={c.selectedId ? projectOfCwd(c.registry.panes.get(c.selectedId)?.info.cwd)?.path : undefined} />
        ) : view === 'scores' ? (
          <AgentScores
            // Same project rule as Project memory: a pane in a separate copy belongs to the project the copy came from.
            project={c.selectedId ? projectOfCwd(c.registry.panes.get(c.selectedId)?.info.cwd) : null}
            onClose={closeOverlay}
          />
        ) : view === 'review' ? (
          <ReviewDesk
            key={reviewFirst ? 'first' : 'list'}
            openFirst={reviewFirst}
            onOpenPane={(id) => nav.select(id)}
            onClose={closeOverlay}
            renderDetail={(item, ctl) => (
              <ReviewDetail
                item={item}
                onOpenPane={(id) => nav.select(id)}
                onKeep={ctl.keep}
                onKept={ctl.kept}
                onThrow={ctl.throwAway}
              />
            )}
          />
        ) : view === 'settings' ? (
          <SettingsView key={settings.viewKey} {...settings.viewProps} onOpenStore={openStore} />
        ) : view === 'board' ? (
          <AgentBoard c={nav} needsYou={needsYou} onClose={closeOverlay} />
        ) : view === 'newagent' ? (
          <NewAgentHost c={nav} where={where} project={newAgentProject} onSetUp={() => setView('doctor')} onReopenedRun={onReopenedRun} />
        ) : view === 'spaces' && spacesOn ? (
          <SpacesPage />
        ) : view === 'today' && todayOn ? (
          <ErrorBoundary where="Today">
            <TodayPage
              onClose={closeOverlay}
              notify={c.notify}
              panes={c.registry.paneList.map((p) => ({ id: p.info.id, cwd: p.info.cwd, name: c.names.get(p.info.id) ?? p.info.id, status: p.status }))}
              agentName={(type) => c.launchEntries.find((e) => e.type === type)?.label ?? defaultAgentName(type)}
            />
          </ErrorBoundary>
        ) : view === 'device' && remoteRow && deviceGroups.enabled && deviceGroups.view?.devices.find((d) => d.node === remoteRow.node) ? (
          <ErrorBoundary where="Device pane" resetKeys={[remoteRow.key]}>
            {farRowEnded && !remoteRow.chat ? (
              <FarGone
                device={deviceGroups.view!.devices.find((d) => d.node === remoteRow.node)!}
                chat={remoteRow.chat}
                onClose={() => (deviceGroups.forget?.(remoteRow.key), deviceGroups.refresh(), setRemoteRow(null), setView(homeView(c.spawn !== null, c.selectedId)))}
              />
            ) : (
            <FarPane
              key={remoteRow.key}
              device={deviceGroups.groups.find((g) => g.device.node === remoteRow.node)?.device ?? deviceGroups.view!.devices.find((d) => d.node === remoteRow.node)!}
              row={deviceGroups.groups.flatMap((g) => g.rows).find((r) => r.key === remoteRow.key) ?? remoteRow}
              rows={deviceGroups.groups.find((g) => g.device.node === remoteRow.node)?.rows ?? [remoteRow]}
              c={c}
              openRow={(key) => {
                const next = deviceGroups.groups.flatMap((g) => g.rows).find((r) => r.key === key);
                if (next) setRemoteRow(next);
                // A chat just started on that PC (its list has not caught up): open it by its key, as a start from New agent does.
                else if (key.startsWith(`dev:${remoteRow.node}:`)) {
                  deviceGroups.refresh();
                  setRemoteRow({ ...remoteRow, key, paneId: key.slice(`dev:${remoteRow.node}:`.length), title: '', agent: '', status: 'idle', cwd: '', project: '', chat: true });
                }
              }}
              ended={farRowEnded}
              onRetry={deviceGroups.refresh}
              onClosed={() => (deviceGroups.forget?.(remoteRow.key), deviceGroups.refresh(), setRemoteRow(null), setView(homeView(c.spawn !== null, c.selectedId)))}
              extras={{ onWhatBroke: setWhatBrokePane, onSeeDay: todayOn ? () => setView('today') : undefined, handoff }}
            />
            )}
          </ErrorBoundary>
        ) : c.chatStarting ? (
          // Before the pane views, so the skeleton shows over the inbox or the pane that was open.
          <ChatStartingView start={c.chatStarting} />
        ) : view === 'spawn' && c.spawn ? (
          <SpawnView spawn={c.spawn} onDismiss={c.dismissSpawn} />
        ) : view === 'task' && openTaskId ? (
          <ErrorBoundary where="Task" resetKeys={[openTaskId]}>
            <TaskMainView c={c} taskId={openTaskId} onGone={() => (setOpenTaskId(null), setView(homeView(c.spawn !== null, c.selectedId)))} />
          </ErrorBoundary>
        ) : view === 'companion' && companion ? (
          <CompanionPage
            key={companion.id}
            companion={companion}
            transport={tauriCompanionTransport}
            onShowTerminal={(paneId) => nav.select(paneId)}
            onOpenCard={() => nav.select(null)}
            onNotify={c.notify}
            onChanged={companions.refresh}
            companions={companions.companions}
            onSwitch={openCompanion}
            onArchived={() => {
              setCompanionId(null);
              nav.select(null);
            }}
          />
        ) : view === 'pane' && c.selectedId && splitOn && split ? (
          <SplitView
            c={nav}
            leftId={c.selectedId}
            rightId={split}
            focus={side}
            ratio={ratio}
            below={belowNow}
            onFocus={setSide}
            onRatio={setRatio}
            onRows={(col, rows) => setBelow((b) => (col === 'left' ? { ...b, leftRows: rows } : { ...b, rightRows: rows }))}
            onClose={toggleSplit}
            onCloseChat={closeChatSlot}
            onSplitDown={splitDownFrom}
          />
        ) : view === 'pane' && c.selectedId ? (
          <ErrorBoundary where="Pane" resetKeys={[c.selectedId]}>
            <PaneView c={c} paneId={c.selectedId} key={c.selectedId} onWhatBroke={setWhatBrokePane} onSeeDay={todayOn ? () => setView('today') : undefined} handoff={handoff} />
          </ErrorBoundary>
        ) : (
          <Inbox
            c={nav}
            visit={inboxVisit}
            onOpenMorning={() => setView('morning')}
            onOpenDoctor={() => setView('doctor')}
            onSetUp={welcomeSetUp}
            onStartAgent={() => {
              setNewAgentProject(null);
              setView('newagent');
            }}
            companions={companions.companions}
            onRestartCompanion={(id) => tauriCompanionTransport.restart(id).finally(companions.refresh)}
            companionTransport={{
              agents: () => tauriCompanionTransport.agents(),
              update: (id, patch) => tauriCompanionTransport.update(id, patch).finally(companions.refresh),
            }}
          />
        )}
        <WorkAreaDrop shown={shownNow} remembered={ratio} partnerOf={partnerFor} nameOf={titleOfPane} onDrop={dropChat} />
        <LiveBar />
        {away.digest && c.mode !== 'individual' && (
          <AwayDigest
            digest={away.digest}
            now={c.now}
            onDismiss={away.dismissDigest}
            onOpenPane={(id) => {
              away.dismissDigest();
              nav.select(id);
            }}
            onOpenInbox={() => {
              away.dismissDigest();
              nav.select(null);
            }}
          />
        )}
        {focusMode && (
          <button type="button" className="ck-focus-exit" title={t('pane.focusExitTip')} onClick={() => setFocusMode(false)}>
            {t('pane.focusExit')}
          </button>
        )}
        {/* The update notice lands here, in the flow under the page, so it never covers the Files tree, Settings or the box. */}
        <div className="ck-update-slot" />
      </main>
      <DragLayer />
      {paletteOpen && (
        <Palette
          key={paletteMode}
          c={nav}
          farHosts={farHosts}
          farSelected={view === 'device' && remoteRow?.chat ? remoteRow.key : null}
          openFar={openFarChat}
          farChats={farChats}
          initialMode={paletteMode}
          onClose={() => setPaletteOpen(false)}
          onOpenDoctor={() => setView('doctor')}
          onStopAll={stopAll}
          onOpenMemory={() => setView('memory')}
          onOpenPlans={() => setView('plans')}
          onOpenMorning={() => setView('morning')}
          onOpenScores={() => setView('scores')}
          onOpenTeam={() => openConnectPage('team')}
          onOpenReview={() => openReview()}
          onReviewRiskiest={() => openReview(true)}
          onOpenStore={openStore}
          onUndoLastTurn={setUndoPane}
          onWhatBroke={setWhatBrokePane}
          onOpenWelcome={welcome.reopen}
          onStartCrew={() => setCrewOpen(true)}
          onOpenInbox={() => {
            nav.select(null);
            setView('inbox');
            setInboxVisit((n) => n + 1);
          }}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          companions={companions.companions}
          onOpenCompanion={openCompanion}
          onNewCompanion={companions.companions ? () => setSetupOpen(true) : undefined}
        />
      )}
      {crewOpen && (
        <StartCrewSheet
          defaultFolder={c.selectedId ? (c.registry.panes.get(c.selectedId)?.info.cwd ?? null) : null}
          agentName={(id) => agentLabel(agentListing, id)}
          onClose={() => setCrewOpen(false)}
        />
      )}
      {goLive && (
        <GoLiveSheet
          panes={sharePanes(c.registry.paneList, c.names, agentListing)}
          currentPaneId={goLive.paneId ?? c.selectedId ?? undefined}
          teamRelay={teamRelay}
          onClose={() => setGoLive(null)}
        />
      )}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      {setupOpen && (
        <CompanionSetupSheet
          transport={tauriCompanionTransport}
          companions={companions.companions ?? []}
          onClose={() => setSetupOpen(false)}
          onCreated={(created, note) => {
            setSetupOpen(false);
            if (note) c.notify(note);
            companions.refresh();
            openCompanion(created.id);
          }}
        />
      )}
      {undoPane && (
        <UndoSheet
          paneId={undoPane}
          // A chat of another PC is undone on that PC (its own checkpoints); any other on this one.
          api={undoApi}
          sharedWith={panesSharingFolder(c.registry.paneList, c.names, undoPane)}
          notify={c.notify}
          onClose={() => setUndoPane(null)}
        />
      )}
      {whatBrokePane && (
        <WhatBrokeItSheet
          paneId={whatBrokePane}
          sharedWith={panesSharingFolder(c.registry.paneList, c.names, whatBrokePane)}
          notify={c.notify}
          onClose={() => setWhatBrokePane(null)}
        />
      )}
      {welcome.open && c.mode !== 'individual' && <FirstRun key={welcome.openKey} c={nav} seed={welcome.seed} onFinish={welcome.finish} />}
      {c.mode !== 'individual' && <TellTeamToast />}
      <ImportHost c={nav} />
      <AddAgentActionHost c={nav} />
      {c.modeExplainer?.open && <IndividualSheet onSwitch={(d) => void c.modeExplainer.confirm(d)} onCancel={c.modeExplainer.cancel} />}
      {stopReport && <PanicSheet report={stopReport} names={c.names} onClose={() => setStopReport(null)} />}
      <AppUpdateHost suppressed={welcomeShown} notify={c.notify} />
      <CockpitJoinLink onJoined={team.refresh} />
      <PassTaskHost teamState={team.state} lend={lend} />
      <StartupCheckLine
        bridgeUp={() => c.bridgeLine === ''}
        actions={{ signIn: (agentId) => openSignInAgain({ agentId, label: agentLabel(agentListing, agentId) }) }}
      />
      {/* "Sign in again" (Usage card, Problems, startup check): a small sheet; the sign-in runs in a hidden pane. */}
      <SignInAgainHost />
      <ControlAskNotice names={c.names} />
      <FullAskNotice />
      <DeskAwayHost />
      {/* The "Used" bar along the bottom edge; the root leaves room for it only while it shows. */}
      <CompanionAssist
        companion={defaultCompanion(companions.companions)}
        needsYou={needsYou}
        panes={assistPanes}
        nameOf={(id) => {
          const p = c.registry.panes.get(id);
          return p ? paneHeading(p.info, c.names.get(id) ?? p.info.agent_type).primary : id;
        }}
        activityOf={(id) => {
          const p = c.registry.panes.get(id);
          return p ? activityText(p.status, c.activities?.[id]) : null;
        }}
        onOpenPane={(id) => nav.select(id)}
        onOpenInbox={() => {
          nav.select(null);
          setView('inbox');
          setInboxVisit((n) => n + 1);
        }}
        onNudge={(id) => void tauri.writeInput(id, NUDGE_TEXT, true)}
      />
      <UsageBar
        // A session that runs on another PC: that PC's usage and limits, tagged with its name (never this PC's numbers). A chat on my own lent sign-in (Use my own agents) is the exception: its numbers are this PC's.
        far={usageFarOf(view === 'device' && remoteRow && deviceGroups.enabled ? { node: remoteRow.node, name: deviceGroups.view?.devices.find((d) => d.node === remoteRow.node)?.name ?? '' } : null, lend, remoteRow?.key)}
        working={c.registry.paneList.filter((p) => p.status === 'running' && !needsYou.some((n) => n.paneId === p.info.id)).length}
        needsYou={needsYou.length}
        trailing={
          <>
            {!welcome.open && welcome.pending && c.mode !== 'individual' && view !== 'settings' && <FinishSetupChip onOpen={welcome.reopen} />}
            <DeskAwayChip />
            <ProblemsChip
              actions={{
                openChat: (id) => nav.select(id),
                signIn: (agentId) => openSignInAgain({ agentId, label: agentLabel(agentListing, agentId) }),
                tryAgain: (agentId) => void nav.newAgent(agentId),
              }}
            />
          </>
        }
      />
      <UndoBar />
      <HandOverSheet notify={c.notify} />
      <FarInstallHost />
      <JumpOutCard
        c={c}
        view={view}
        shown={view === 'pane' ? shownNow : []}
        farOpen={view === 'device' && remoteRow?.chat ? { node: remoteRow.node, paneId: remoteRow.paneId } : null}
        onOpenInbox={() => {
          nav.select(null);
          setView('inbox');
          setInboxVisit((n) => n + 1);
        }}
      />
      <div className="ck-toasts" aria-live="polite">
        {c.toasts.map((t) => (
          <div className="ck-toast" key={t.id}>
            <span>{t.text}</span>
            {t.action && (
              <button type="button" className="ck-toast-action" onClick={t.action.run}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
    </LiveStatusContext.Provider>
    </LastTurnContext.Provider>
    </FarNeedsContext.Provider>
    </NeedsYouContext.Provider>
    </LoopGuardContext.Provider>
  );
}
