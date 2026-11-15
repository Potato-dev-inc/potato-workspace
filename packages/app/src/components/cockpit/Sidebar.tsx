import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PaneContextMenu } from './PaneContextMenu';
import { helperRows } from './rail/helperRows';
import { AdoptZone } from '../dnd/AdoptZone';
import { useAdopt } from './useAdopt';
import { tauriAdoptApi, type AdoptApi } from '../../lib/helperAdopt';
import { openHandoffFile, type HandoffDeps } from '../../lib/handoff';
import { useHandoff, type HandoffControl } from '../../hooks/useHandoff';
import { requestPaneAction, type PaneAction } from '../../lib/pane-actions';
import { NewAgentMenu, type ProjectChoice } from './NewAgentMenu';
import { shipApi, type GitState, type ShipApi } from '../../lib/ship-api';
import { tauri } from '../../lib/tauri';
import { useAcpLanes } from '../../hooks/useAcpLanes';
import { addableChat, chatCapable, errorSentence, startTerminalChat, tauriAcpChatApi, terminalChatCapable, type AcpChatApi } from '../../lib/acpChat';
import { tauriAcpAddonApi, type AcpAddonApi } from '../../lib/acpAddon';
import { settingsStartModeApi, useStartMode, type StartModeApi } from '../../lib/newAgentStart';
import type { AddChatKind, NoChatAgent } from './NoChatPrompt';
import { requestChatTab } from '../../lib/chatTab';
import { AddChatDialog } from '../settings/blocks/AddChatDialog';
import { tauriPickApi } from '../../lib/pick-for-me';
import { isValidProjectPath } from '../../lib/project-path';
import { copyDefault, lastRealFolder, projectOfCwd, readStoredCopyPreference, supportsCopies, writeCopyPreference } from '../../lib/ship-model';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useNeedsYou } from '../../hooks/useNeedsYou';
import { blockingItems, itemsOfKind, needsYouPaneIds } from '../../lib/attention';
import { activityText } from '../../lib/pane-activity';
import { mainPreview, type PreviewUrl } from '../../lib/pane-preview';
import '../../styles/live-preview.css';
import '../../styles/cockpit-helpers.css';
import '../../styles/cockpit-sidebar.css';
import { DotSpinner } from './DotSpinner';
import { useT } from '../../i18n';
import { PotatoMark, IconChevronDown, IconClosedChats, IconFolderPlus, IconGlobe, IconInbox, IconMore, IconNewAgent, IconPin, IconSearch, IconSort, IconTeam } from './Icons';
import { RowMark } from './RowMark';
import { PlanLine } from '../common/PlanLine';
import { ProjectHeader, ProjectMeta, type ProjectSignal } from './ProjectHeader';
import { groupByBranch, primaryBranch, projectChanges, usePaneCards } from './useProjectCard';
import { SidebarFooter } from './SidebarFooter';
import { SidebarWarmLine } from './SidebarWarmLine';
import { dragSourceProps } from '../dnd/dragSourceProps';
import { ReorderList } from '../dnd/ReorderList';
import { applyOrder, moveToSlot } from '../dnd/reorder';
import { PinnedGroup } from './PinnedGroup';
import { DropFolderSheet, useFolderDrop } from './DropFolderSheet';
import { chatItems, rowIdOf } from './sidebar-reorder';
import { useChatOrder } from '../../lib/sidebarOrder';
import { requestPotatoCheck } from '../../lib/potatoCheck';
import { chatSummaryOf, requestPassTask } from '../../lib/team-pass-bridge';
import { bindingLabel, isMacPlatform } from '../../lib/shortcuts';
import { groupByProject, useFoldedProjects, useGroupBy, useSidebarProjects } from '../../lib/sidebarProjects';
import { formatElapsed, spinnerStatus } from './model';
import { splitPinned, usePinnedPanes } from '../../lib/pinnedPanes';
import { useHelpersInSidebar } from '../../lib/helpersInSidebar';
import { descendants, groupHelperTree, readFoldedParents, writeFoldedParents, liveParentId, type HelperNode } from '../../lib/pane-helpers';
import { markStandbyOpen, openNewStandby, tauriStandbyHelpersApi, useStandbyHelpers, type StandbyHelpersApi } from '../../lib/standbyHelpers';
import { placeHelpers, type StandbyRow } from './standby-rows';
import { SidebarStandbyRow, type StandbyRowActions } from './SidebarStandbyRow';
import { folderKey } from './history-model';
import { multiLoginAgents, paneHeading, paneSubline } from './titles';
import { LastTurnContext } from './away-context';
import { projectWithCopy } from './shell-labels';
import type { CompanionView } from '../../lib/companion';
import { CompanionRow, MakeCompanionRow, NewCompanionRow } from './companion/CompanionRow';
import { companionMood, useJustFinished, useLocalHour } from '../../lib/companionMood';
import { isCompanionPaneId, MAX_COMPANIONS } from './companion/model';
import { useReviewCount } from './review/useReviewCount';
import { ClosedChatsSheet } from './ClosedChatsSheet';
import { PeekCard } from './PeekCard';
import { usePeek } from './usePeek';
import { showUndo } from '../../lib/undo-bar';
import { tauriClosedChatsApi, useClosedChats, type ClosedChatsApi } from '../../lib/closedChats';

/** `localhost:5173`: where the preview is, without the scheme. */
const previewAddress = (p: PreviewUrl): string => p.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
import { StartMissionSheet } from './mission/StartMissionSheet';
import { onOpenStartMission, useMissions, useMissionsEnabled, isActive } from '../../lib/missions';
import { TonightHost } from './night/TonightHost';
import { onOpenTonight } from '../../lib/night-host';
import { useNightEnabled } from '../../lib/night';
import { BringChatsLink } from '../history/BringChatsLink';
import { DeviceGroups } from '../devices/DeviceGroups';
import { NewAgentWhere, type WhereProps } from '../devices/NewAgentWhere';
import type { DeviceGroup, RemoteRow } from '../devices/useDeviceGroups';
import { useDismissable } from '../../hooks/useDismissable';

export function Sidebar({
  c,
  onOpenPalette,
  onOpenDoctor,
  onOpenMemory,
  onOpenPlans,
  onOpenScores,
  onOpenReview,
  onOpenMorning,
  onOpenRoutines,
  onOpenStore,
  companions,
  openCompanionId = null,
  onOpenCompanion,
  onOpenInbox,
  onNewCompanion,
  onOpenNewAgent,
  newAgentOpen = false,
  spaces,
  spacesOpen = false,
  onOpenSpaces,
  onOpenToday,
  todayOpen = false,
  team,
  canPassTask,
  onOpenTeam,
  onOpenToSide,
  onOpenPlaced,
  onPaneAction,
  ship = shipApi,
  acp = tauriAcpChatApi,
  addons = tauriAcpAddonApi,
  startModeApi = settingsStartModeApi,
  closedChatsApi = tauriClosedChatsApi,
  adoptApi = tauriAdoptApi,
  handoffDeps,
  handoff,
  devices,
  standbyApi = tauriStandbyHelpersApi,
}: {
  c: CockpitApi;
  onOpenPalette: () => void;
  onOpenDoctor?: () => void;
  onOpenMemory?: () => void;
  onOpenPlans?: () => void;
  /** Opens "Scores on your code" (which agent works best in the selected pane's project). */
  onOpenScores?: () => void;
  /** Opens the Review Desk (finished work, riskiest first). Absent: no Review button. */
  onOpenReview?: () => void;
  /** Night Shift: opens the Morning page. Absent: no Night Shift chip. */
  onOpenMorning?: () => void;
  /** Routines and Chains: opens the Routines page. Absent: no menu row. */
  onOpenRoutines?: () => void;
  /** The "More agents…" row of the New agent menu opens the Agent Store. Absent: no row. */
  onOpenStore?: () => void;
  /** The pane row menu's "Open to the side" (split view). Absent: the menu has no such item. */
  onOpenToSide?: (paneId: string) => void;
  /** Row menu: open a chat on the left or below the one in front (the keyboard way to a drag onto the work area). */
  onOpenPlaced?: (paneId: string, where: 'left' | 'down') => void;
  /** Runs a pane action of the row menu (rename, reflow, copy, details, close). Absent: select the pane, then ask its view. */
  onPaneAction?: (paneId: string, action: PaneAction) => void;
  /** The companions, above Inbox. Absent or null: no companion rows (no backend, or not read yet). */
  companions?: CompanionView[] | null;
  /** The companion whose page is open, if any: its row is the active one. */
  openCompanionId?: string | null;
  onOpenCompanion?: (id: string) => void;
  /** The Inbox row was chosen (the Inbox may already be the view on screen). */
  onOpenInbox?: () => void;
  onNewCompanion?: () => void;
  /** The New agent page: the New agent row opens it (with a project preselected from a project's "+"). Absent: the row opens the quick menu. */
  onOpenNewAgent?: (project?: { path: string; name: string }) => void;
  /** The New agent page is the view on screen: the New agent row is the active one (and the Inbox row is not). */
  newAgentOpen?: boolean;
  /** Spaces (Labs `spaces_enabled`). The Spaces row shows only when `enabled` is true. */
  spaces?: { enabled: boolean };
  /** The Spaces page is the view on screen: its row is the active one. */
  spacesOpen?: boolean;
  /** Opens the Spaces page. Absent: no Spaces row. */
  onOpenSpaces?: () => void;
  /** Opens the Today page (Labs `timeline_day_enabled`). Absent: no Today button. */
  onOpenToday?: () => void;
  todayOpen?: boolean;
  /** The Team page: its row (always shown) is the active one while `open`; `waiting` is the number on its badge. Absent: no Team row. */
  team?: { open: boolean; waiting: number };
  onOpenTeam?: () => void;
  /** A team is on: a chat's menu offers "Pass to a teammate…". */
  canPassTask?: boolean;
  ship?: ShipApi;
  /** Chat sessions (ACP): which agents can run as a chat, and starting one. Replaceable in tests. */
  acp?: AcpChatApi;
  /** The chat add-ons (status, install). Replaceable in tests. */
  addons?: AcpAddonApi;
  /** Where the New agent menu's Chat | Terminal choice is saved. Replaceable in tests. */
  startModeApi?: StartModeApi;
  /** The closed chats (list, reopen, delete). Replaceable in tests. */
  closedChatsApi?: ClosedChatsApi;
  /** "Make helper of…" (drag an agent onto another, or the row menu). Replaceable in tests. */
  adoptApi?: AdoptApi;
  /** The calls "Handoff from here" makes. Replaceable in tests. */
  handoffDeps?: HandoffDeps;
  /** The cockpit's shared handoff (also used by the pane's "Hand off" button). Absent: the sidebar keeps its own. */
  handoff?: HandoffControl;
  /** Devices (Labs): the groups of other PCs under this PC's rows, and what choosing one of their rows does. Absent or no groups: nothing changes. */
  devices?: { groups: DeviceGroup[]; selectedKey: string | null; onOpen: (row: RemoteRow) => void; onRetry?: () => void; where?: WhereProps };
  /** The standby helpers (list, add, remove, open). Replaceable in tests. */
  standbyApi?: StandbyHelpersApi;
}) {
  const t = useT();
  const list = c.registry.paneList;
  // Closed chats: read again whenever the set of panes changes (a chat was closed or reopened).
  const { chats: closedChats, reload: reloadClosed } = useClosedChats(closedChatsApi, list.map((p) => p.info.id).join('|'));
  const [closedOpen, setClosedOpen] = useState(false);
  // `Review 4`: how many finished things wait to be looked at. Hidden at 0.
  const reviewCount = useReviewCount(onOpenReview !== undefined);
  // A companion's pane has its own companion row above; it is not listed again as a plain pane.
  // Standby helpers: each sits under its home agent. A chat the person opened on one is that helper's row, not an agent.
  const { view: standbyView, apply: applyStandby } = useStandbyHelpers(standbyApi);
  const [showHelperTree] = useHelpersInSidebar();
  // Opening a standby makes its chat before the list of helpers says so: until it does, a chat that just appeared is not an agent.
  const [openingFrom, setOpeningFrom] = useState<ReadonlySet<string> | null>(null);
  const opening = new Set(openingFrom ? list.filter((p) => !openingFrom.has(p.info.id)).map((p) => p.info.id) : []);
  const placement = placeHelpers(showHelperTree ? standbyView.helpers : [], list, opening);
  // A chat that is a seat's own came or went (a task started or ended): read the helpers again now, not at the next poll.
  const seatChats = list.filter((p) => p.info.standby_seat).map((p) => p.info.id).join(' ');
  useEffect(() => {
    void standbyApi.get().then(applyStandby).catch(() => {});
  }, [seatChats]); // eslint-disable-line react-hooks/exhaustive-deps
  // A chat that is a standby's own never counts as an agent row.
  const panes = list.filter((p) => !isCompanionPaneId(p.info.id) && !placement.hiddenPanes.has(p.info.id));
  // The same list the Inbox badge and the Doto counter use, so the three numbers always agree.
  const needs = useNeedsYou(c);
  const questionPanes = needsYouPaneIds(needs);
  const grouped = groupHelperTree(panes, questionPanes);
  // Pinned chats sit in their own group at the top, newest pin first, whatever they are doing.
  const { pins, setPinned, place: placePin } = usePinnedPanes();
  const pinSet = new Set(pins);
  const roots = [...grouped.needs, ...grouped.working, ...grouped.idle].filter((n) => !n.awayFrom);
  const { pinned: pinnedNodes } = splitPinned(roots, (n) => n.pane.info.id, pins);
  const pinnedIds = new Set(pinnedNodes.map((n) => n.pane.info.id));
  const unpinned = (items: typeof grouped.needs) => items.filter((n) => n.awayFrom || !pinnedIds.has(n.pane.info.id));
  const groups = { needs: unpinned(grouped.needs), working: unpinned(grouped.working), idle: unpinned(grouped.idle) };
  // Projects view: the folders the person added, which groups are folded, and how the list is grouped.
  const { projects, add: addProject, remove: removeProjectNow, rename: renameProject, reorder: reorderProjects, restore: restoreProjects } = useSidebarProjects();
  // Removing a project only takes it off the sidebar; the undo bar puts the list back exactly as it was.
  const removeProject = (path: string, name: string) => {
    const before = projects;
    removeProjectNow(path);
    showUndo({ text: t('undo.projectRemoved', { name }), failText: t('undo.failed'), undo: () => restoreProjects(before) });
  };
  // The order the person gave their chats by dragging (Projects view).
  const { order: chatOrder, setGroupOrder } = useChatOrder();
  // A folder dragged in from Windows: "Add as a project?"
  const sideRef = useRef<HTMLElement>(null);
  const folderDrop = useFolderDrop(sideRef);
  const { folded: foldedProjects, toggle: toggleProject } = useFoldedProjects();
  const [groupBy, setGroupBy] = useGroupBy();
  // Parents whose helpers the person folded away (the helpers that need you stay listed in Needs you).
  const [folded, setFolded] = useState<ReadonlySet<string>>(readFoldedParents);
  const toggleFolded = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      writeFoldedParents(next);
      return next;
    });
  const waiting = blockingItems(needs).length;
  // The companion's mood: agents waiting or working, a run that just finished, the time of day.
  const hour = useLocalHour();
  const workingCount = grouped.working.length;
  const justFinished = useJustFinished(workingCount);
  const waitingName = grouped.needs.length === 1 ? (c.names.get(grouped.needs[0].pane.info.id) ?? null) : null;
  // Questions agents asked through ask_user: they belong to no pane row, so they get a row of their own.
  const asks = itemsOfKind(blockingItems(needs), 'question').length;
  const multiLogin = multiLoginAgents(list.map((p) => p.info));
  const lastTurn = useContext(LastTurnContext);
  // The quick look at an agent: rest on a row or press Space on it.
  const peek = usePeek();
  const [menuOpen, setMenuOpen] = useState(false);
  // The right-click menu of a pane row: where it opened, and which pane it is for.
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // The row the menu opened from: the keyboard goes back to it when the menu closes with Escape.
  const rowMenuFrom = useRef<HTMLElement | null>(null);
  const closeRowMenu = useCallback((refocus: boolean) => {
    setRowMenu(null);
    if (refocus) rowMenuFrom.current?.focus();
  }, []);
  // "Handoff from here": one at a time; the line under the list says where it is. The cockpit may share one with the pane's bar.
  const ownHandoff = useHandoff(c, handoffDeps);
  const hand = handoff ?? ownHandoff;
  const handoffBusy = hand.busy;
  // An action of the row's pane: the pane opens (selected) and its own view runs it, or it is run here (Interrupt).
  const runPaneAction = (id: string, action: PaneAction) => (onPaneAction ?? defaultPaneAction)(id, action);
  const defaultPaneAction = (id: string, action: PaneAction) => {
    c.select(id);
    requestPaneAction(id, action);
  };
  // The folder step: an explicit choice wins, else the selected pane's project.
  const [chosen, setChosen] = useState<ProjectChoice | null>(null);
  const selectedCwd = c.selectedId ? c.registry.panes.get(c.selectedId)?.info.cwd : undefined;
  // With neither, new agents start in the open project (the app's default folder): name it too.
  const [openProject, setOpenProject] = useState<string | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    let live = true;
    tauri
      .getProjectPath()
      .then((path) => live && setOpenProject(isValidProjectPath(path) ? path : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [menuOpen]);
  // The newest real folder the person used: "+" starts there when no pane names a project.
  const [lastFolder, setLastFolder] = useState<ProjectChoice | null>(null);
  useEffect(() => {
    let live = true;
    ship
      .recent()
      .then((list) => live && setLastFolder(lastRealFolder(list)))
      .catch(() => undefined); // no desktop shell: the open project is used
    return () => {
      live = false;
    };
  }, [menuOpen, ship]);
  const base: ProjectChoice | null = chosen ?? projectOfCwd(selectedCwd) ?? lastFolder ?? projectOfCwd(openProject);
  // A folder taken from a pane has no Git state yet: ask once, so the Separate copy switch knows.
  const [looked, setLooked] = useState<{ path: string; state: GitState } | null>(null);
  useEffect(() => {
    if (!base || base.state) return;
    let live = true;
    ship
      .gitState(base.path)
      .then((state) => live && setLooked({ path: base.path, state }))
      .catch(() => undefined); // no desktop shell (a browser): the switch stays as it is
    return () => {
      live = false;
    };
  }, [base?.path, base?.state, ship]); // eslint-disable-line react-hooks/exhaustive-deps
  const project: ProjectChoice | null = base ? { ...base, state: base.state ?? (looked?.path === base.path ? looked.state : undefined) } : null;
  const projectKey = project?.path ?? null;
  // The person's remembered choice for this project wins; with none, off: the agent works in the folder itself.
  const [stored, setStored] = useState(() => readStoredCopyPreference(projectKey));
  useEffect(() => setStored(readStoredCopyPreference(projectKey)), [projectKey]);
  const isolated = copyDefault(stored);
  const menuRef = useRef<HTMLDivElement>(null);
  // Chat sessions (ACP, Labs): the agents with a Terminal | Chat switch in the menu. Read when the menu opens.
  const laneView = useAcpLanes(menuOpen, acp);
  const chatAgents = chatCapable(laneView);
  const addableAgents = addableChat(laneView);
  const terminalChatAgents = terminalChatCapable(laneView);
  const [setUpFor, setSetUpFor] = useState<{ agent: NoChatAgent; prefer?: AddChatKind } | null>(null);
  const [startMode, setStartMode] = useStartMode(menuOpen, startModeApi);
  /** Starts the agent's chat in the menu's project and opens it. Rejects with the backend's error. */
  // The main area shows a starting skeleton at once (ChatStartingView) until the chat is selected. On a failure the
  // skeleton goes and the rejection goes on to the menu, which shows why (and the terminal fallback).
  const startAcpChat = async (agentId: string, accountId?: string) => {
    if (!project) throw new Error('Pick a project folder first.');
    const startId = c.beginChatStart(agentId, project.path);
    let started: Awaited<ReturnType<AcpChatApi['start']>>;
    try {
      // The menu's copy switch ("Work on a copy") is on: the chat works in a copy of this project.
      const onCopy = isolated && supportsCopies(project.state);
      started = await (onCopy ? acp.start(agentId, project.path, true, accountId, true) : accountId === undefined ? acp.start(agentId, project.path, true) : acp.start(agentId, project.path, true, accountId));
    } catch (err) {
      c.endChatStart(startId);
      throw err;
    }
    c.endChatStart(startId);
    c.select(started.pane_id);
  };
  // Missions (Preview, Labs): "+" → Start a mission… opens the start sheet for the menu's project.
  const missionsOn = useMissionsEnabled();
  const missions = useMissions();
  const [missionFor, setMissionFor] = useState<ProjectChoice | null>(null);
  useEffect(() => onOpenStartMission((path) => {
    const p = path ? projectOfCwd(path) : project;
    if (p) setMissionFor(p);
  }), [project]);
  // Night Shift (Labs): "+" → Tonight… and the palette open the Tonight sheet; the chip below shows a run.
  const nightOn = useNightEnabled();
  const [tonightOpen, setTonightOpen] = useState(false);
  useEffect(() => onOpenTonight(() => setTonightOpen(true)), []);
  useEffect(() => {
    const open = () => setMenuOpen(true);
    window.addEventListener('pm:open-new-menu', open);
    return () => window.removeEventListener('pm:open-new-menu', open);
  }, []);

  useDismissable(menuOpen, { inside: [menuRef], anchor: menuRef, onDismiss: () => setMenuOpen(false) });

  type Pane = (typeof list)[number];
  const paneTitle = (p: Pane) => paneHeading(p.info, c.names.get(p.info.id) ?? p.info.agent_type).primary;
  const adoptName = (id: string) => {
    const p = c.registry.panes.get(id);
    return p ? paneTitle(p) : id;
  };
  // Drag an agent onto another (or the row menu): it becomes that agent's helper, in the same project only.
  const adopt = useAdopt({
    panes,
    projectOf: (cwd) => groupByProject([cwd], (x) => x, projects).find((g) => g.items.length > 0)?.key ?? 'other',
    nameOf: adoptName,
    api: adoptApi,
    notify: c.notify,
  });
  const agentLabelOf = (agent: string) => c.launchEntries.find((e) => e.type === agent)?.label ?? agent;
  const standbyActions: StandbyRowActions = {
    open: async (r) => {
      if (r.paneId) return void c.select(r.paneId);
      setOpeningFrom(new Set(list.map((p) => p.info.id)));
      markStandbyOpen('click');
      try {
        const id = await standbyApi.open(r.helper.id);
        // The pane is shown the moment its id is known; the row learns which chat is its own right after, and until it does the
        // new chat is not drawn as an agent (`opening`).
        if (id) {
          c.select(id);
          markStandbyOpen('selected');
        } else c.notify(t('standby.openFailed'));
      } catch (e) {
        c.notify(errorSentence(e));
      }
      void standbyApi
        .get()
        .then(applyStandby)
        .catch(() => {})
        .finally(() => setOpeningFrom(null));
    },
    detach: (r) => {
      const h = r.helper;
      const home = r.under;
      void standbyApi.detach(h.id).then(applyStandby).catch((e) => c.notify(errorSentence(e)));
      showUndo({
        text: t('standby.detached', { name: h.name }),
        failText: t('undo.failed'),
        ms: 5000,
        undo: async () => applyStandby(home ? await standbyApi.update(h.id, { home }) : await standbyApi.get()),
      });
    },
    close: (r) => {
      const h = r.helper;
      void standbyApi.remove(h.id).then(applyStandby).catch(() => {});
      showUndo({
        text: t('standby.removed', { name: h.name }),
        failText: t('undo.failed'),
        ms: 5000,
        undo: async () => applyStandby(await standbyApi.add({ name: h.name, agent: h.agent, model: h.model, project: h.project, after_task: h.after_task, home: h.home })),
      });
    },
    rename: (r, name) => void standbyApi.update(r.helper.id, { name }).then(applyStandby).catch((e) => c.notify(errorSentence(e))),
    setModel: (r, model) => void standbyApi.update(r.helper.id, { model }).then(applyStandby).catch((e) => c.notify(errorSentence(e))),
    setAfter: (r, after) => void standbyApi.update(r.helper.id, { after_task: after }).then(applyStandby).catch((e) => c.notify(errorSentence(e))),
    moveUnder: (r, agentId) => void standbyApi.update(r.helper.id, { home: agentId }).then(applyStandby).catch((e) => c.notify(errorSentence(e))),
    start: (r) => void standbyApi.start(r.helper.id).then(applyStandby).catch(() => {}),
  };
  /** The other main agents of the helper's project: where "Move under" can send it. */
  const movableFor = (r: StandbyRow) =>
    list
      .filter((p) => !isCompanionPaneId(p.info.id) && !placement.hiddenPanes.has(p.info.id) && !liveParentId(list, p.info.id) && p.info.id !== r.under && folderKey(p.info.cwd) === folderKey(r.helper.project))
      .map((p) => ({ id: p.info.id, title: paneTitle(p) }));
  const underTitleOf = (r: StandbyRow) => {
    const agent = r.under ? list.find((p) => p.info.id === r.under) : undefined;
    return agent ? paneTitle(agent) : null;
  };
  const standbyRowView = (r: StandbyRow) => (
    <SidebarStandbyRow key={`sb-${r.helper.id}`} row={r} agentLabel={agentLabelOf(r.helper.agent)} active={r.paneId !== null && c.selectedId === r.paneId} movable={movableFor(r)} underTitle={underTitleOf(r)} actions={standbyActions} />
  );
  // Told once when a helper's home agent was closed and another agent took it in.
  const lastUnder = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const now = new Map<string, string>();
    const moved = new Map<string, number>();
    for (const rows of placement.byAgent.values()) for (const r of rows) now.set(r.helper.id, r.under ?? '');
    const live = new Set(list.map((p) => p.info.id));
    for (const [id, under] of now) {
      const before = lastUnder.current.get(id);
      if (before && before !== under && !live.has(before)) moved.set(under, (moved.get(under) ?? 0) + 1);
    }
    lastUnder.current = now;
    for (const [under, count] of moved) {
      const agent = list.find((p) => p.info.id === under);
      if (agent) c.notify(t('standby.moved', { count, agent: paneTitle(agent) }));
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  /** Helpers no agent can hold yet (their project has no main agent): a small group of their own. */
  const looseGroup = (rows: StandbyRow[]) =>
    rows.length === 0 ? null : (
      <div className="ck-sb-loose" role="group" aria-label={t('standby.looseGroup')} data-testid="standby-loose">
        <div className="ck-sb-loose-head">{t('standby.looseGroup')}</div>
        {rows.map(standbyRowView)}
      </div>
    );
  // A toast when an agent takes a helper the person was using (it shows even when they look somewhere else).
  const toldTaken = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const h of standbyView.helpers) {
      if (!h.taken_over) {
        toldTaken.current.delete(h.id);
        continue;
      }
      if (toldTaken.current.has(h.id)) continue;
      toldTaken.current.add(h.id);
      const parentId = h.pane_id ? liveParentId(list, h.pane_id) : null;
      const parent = parentId ? list.find((p) => p.info.id === parentId) : undefined;
      c.notify(parent ? t('standby.tookToast', { agent: paneTitle(parent), name: h.name }) : t('standby.tookAnon', { name: h.name }));
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const row = (p: Pane, awayFrom?: Pane, helperCount = 0) => {
    const id = p.info.id;
    const since = c.statusSince.get(id);
    const active = c.selectedId === id && !c.spawn && !openCompanionId;
    const heading = paneHeading(p.info, c.names.get(id) ?? p.info.agent_type);
    const detail =
      activityText(p.status, c.activities?.[id]) ??
      (p.status === 'error' ? t('sidebar.errorIn', { where: projectWithCopy(p.info.cwd) }) : projectWithCopy(p.info.cwd));
    const subline = paneSubline(
      p.info,
      c.names.get(id) ?? p.info.agent_type,
      // Away from its parent (in Needs you) a helper says whose it is.
      awayFrom ? t('sidebar.helperOf', { name: paneTitle(awayFrom), detail }) : detail,
      multiLogin,
    );
    const entry = c.launchEntries.find((e) => e.type === p.info.agent_type);
    const asking = p.status === 'waiting_input' || questionPanes.has(id);
    const pill = asking && p.status !== 'error';
    const broken = p.status === 'error';
    const working = p.status === 'running' && !asking;
    const calm = !asking && !broken && !working;
    const preview = mainPreview(c.previews, id);
    return (
      <div key={id} className="ck-rowwrap" {...peek.rowProps(id)}>
        <button
          type="button"
          data-pane-row={id}
          className={`ck-row ck-row--slim${active ? ' is-active' : ''}${asking ? ' is-needs' : ''}${broken ? ' is-error' : ''}${calm ? (p.status === 'idle' ? ' is-idle' : ' is-ended') : ''}`}
          onClick={() => c.select(id)}
          {...dragSourceProps({ kind: 'chat', id, label: heading.primary })}
          onContextMenu={(e) => {
            e.preventDefault();
            rowMenuFrom.current = e.currentTarget;
            // Opened from the keyboard (the context-menu key, Shift+F10): there is no pointer, so it opens at the row.
            const r = e.currentTarget.getBoundingClientRect();
            const fromKeyboard = e.clientX === 0 && e.clientY === 0;
            setRowMenu({ id, x: fromKeyboard ? r.left + 24 : e.clientX, y: fromKeyboard ? r.bottom - 4 : e.clientY });
          }}
          title={lastTurn.get(id)?.sentence}
          aria-current={active ? 'true' : undefined}
          aria-label={pill ? t('sidebar.rowNeedsYou', { name: heading.primary }) : undefined}
        >
          <span className="ck-row-glyph">
            <RowMark status={p.status} asking={asking && p.status !== 'error'} agentId={p.info.agent_type} agentName={entry?.label} />
          </span>
          <span className="ck-row-main" title={[...new Set([heading.primary, entry?.label, subline, projectWithCopy(p.info.cwd)])].filter(Boolean).join(' · ')}>
            <span className="ck-row-title">{heading.primary}</span>
            <span className="ck-row-sub">{subline}</span>
            <PlanLine paneId={id} />
          </span>
          {preview && (
            <span className="ck-row-preview" title={t('sidebar.hasPreviewAt', { address: previewAddress(preview) })} role="img" aria-label={t('sidebar.hasPreview')}>
              <IconGlobe />
            </span>
          )}
          {pinSet.has(id) && (
            <span className="ck-row-pin" role="img" aria-label={t('sidebar.pinned')} title={t('sidebar.pinned')}>
              <IconPin />
            </span>
          )}
          {helperCount > 0 && (
            <span className="ck-row-helpers" data-testid="row-helper-count" title={t('sidebar.helperCount', { count: helperCount })} role="img" aria-label={t('sidebar.helperCount', { count: helperCount })}>
              {helperCount}
            </span>
          )}
          {/* The right side says one thing: the chip when it needs you or is broken, the time while it works, else nothing. */}
          {pill ? (
            <span className="ck-row-pill">{t('sidebar.needsYou')}</span>
          ) : broken ? (
            <span className="ck-row-pill ck-row-pill--error">{t('sidebar.error')}</span>
          ) : working ? (
            <span className="ck-row-time">{since ? formatElapsed(c.now - since) : ''}</span>
          ) : null}
        </button>
        {!awayFrom && !p.info.parent_pane_id && p.info.cwd && (
          <button
            type="button"
            className="ck-row-addhelper"
            data-testid="row-add-helper"
            aria-label={t('standby.addAria', { name: heading.primary })}
            title={t('standby.addTitle')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openNewStandby(p.info.cwd, id, { x: r.right + 8, y: r.top });
            }}
          >
            +
          </button>
        )}
        <button
          type="button"
          className="ck-row-more"
          aria-label={t('sidebar.moreFor', { name: heading.primary })}
          title={t('sidebar.more')}
          aria-haspopup="menu"
          onClick={(e) => {
            rowMenuFrom.current = e.currentTarget;
            const r = e.currentTarget.getBoundingClientRect();
            setRowMenu({ id, x: r.left, y: r.bottom + 2 });
          }}
        >
          <IconMore />
        </button>
        <AdoptZone paneId={id} name={heading.primary} refusal={(childId) => adopt.refusal(childId, id)} onAdopt={(childId, parentId) => void adopt.adopt(childId, parentId)} />
        {peek.open?.id === id && (
          <div style={{ display: 'contents', ['--peek-left' as string]: `${peek.open.left}px`, ['--peek-top' as string]: `${peek.open.top}px` }}>
            <PeekCard
              c={c}
              paneId={id}
              title={heading.primary}
              lastTurn={lastTurn.get(id)}
              onOpenToSide={onOpenToSide}
              onOpen={(paneId) => c.select(paneId)}
              onClose={peek.close}
              onHover={peek.onCardHover}
            />
          </div>
        )}
      </div>
    );
  };
  // A row, and under it its helpers: indented behind a thin guide line, folded by the "N helpers" chip.
  const node = (n: HelperNode<Pane>): JSX.Element => {
    const id = n.pane.info.id;
    const standbyRows = showHelperTree ? (placement.byAgent.get(id) ?? []) : [];
    if (n.helpers.length === 0 && standbyRows.length === 0) return row(n.pane, n.awayFrom);
    // The helpers bar above the chat is where helpers live: the row only counts them (unless the person wants the tree).
    if (!showHelperTree) return row(n.pane, n.awayFrom, descendants(n).length);
    const open = !folded.has(id);
    return (
      <div key={id} className="ck-node">
        {row(n.pane, n.awayFrom)}
        <div className="ck-helpers" role="group" aria-label={t('sidebar.helpersOf', { name: paneTitle(n.pane) })}>
          <button
            type="button"
            className="ck-chip-count ck-helper-chip"
            onClick={() => toggleFolded(id)}
            aria-expanded={open}
            title={t(open ? 'sidebar.hideHelpers' : 'sidebar.showHelpers')}
          >
            {t('state.helpers', { count: descendants(n).length + standbyRows.length })}
            <span className={`ck-helper-caret${open ? ' is-open' : ''}`} aria-hidden="true" />
          </button>
          {open && n.helpers.map(node)}
          {open && standbyRows.map(standbyRowView)}
        </div>
      </div>
    );
  };

  const questionsRow = (n: number) => (
    <button type="button" className="ck-row" onClick={() => c.select(null)}>
      <span className="ck-row-glyph">
        <DotSpinner status="waiting_input" />
      </span>
      <span className="ck-row-main">
        <span className="ck-row-title">{t('sidebar.questionsFromAgents')}</span>
      </span>
      <span className="ck-row-time">{n}</span>
    </button>
  );
  const section = (title: string, items: HelperNode<Pane>[], count?: number, extraRow = 0) =>
    items.length === 0 && extraRow === 0 ? null : (
      <div className="ck-group" key={title}>
        <div className="ck-caption">
          {title}
          {count ? <span className="ck-caption-count">{count}</span> : null}
        </div>
        {items.map(node)}
        {extraRow > 0 && questionsRow(extraRow)}
      </div>
    );

  // The Projects view: every top-level agent under the folder it works in (see groupByProject).
  const projectRoots = applyOrder(
    roots.filter((n) => !pinnedIds.has(n.pane.info.id)),
    (n) => n.pane.info.id,
    chatOrder,
  );
  const projectGroups = groupByProject(projectRoots, (n) => n.pane.info.cwd, projects);
  // Branch, copy and change counts of each top-level agent: asked again only when its status changes.
  const cards = usePaneCards(groupBy === 'projects' ? projectRoots.map((n) => ({ id: n.pane.info.id, status: n.pane.status })) : []);
  const newAgentIn = (path: string, name: string) => {
    if (onOpenNewAgent) {
      onOpenNewAgent({ path, name });
      return;
    }
    setChosen({ path, name });
    setMenuOpen(true);
  };
  const addFolder = async () => {
    try {
      const found = await ship.pickFolder();
      if (found?.path) addProject(found.path);
    } catch {
      c.notify(t('sidebar.folderPickerFailed'));
    }
  };
  const sectionBar = (
    <div className="ck-sechead">
      <span className="ck-sechead-text">{t(groupBy === 'projects' ? 'sidebar.projects' : 'sidebar.statusHeading')}</span>
      <button
        type="button"
        className="ck-sechead-btn"
        aria-label={t(groupBy === 'projects' ? 'sidebar.groupByStatus' : 'sidebar.groupByProject')}
        title={t(groupBy === 'projects' ? 'sidebar.groupByStatusTip' : 'sidebar.groupByProjectTip')}
        onClick={() => setGroupBy(groupBy === 'projects' ? 'status' : 'projects')}
      >
        <IconSort />
      </button>
      <button type="button" className="ck-sechead-btn" data-testid="side-add-project-btn" aria-label={t('sidebar.addProject')} title={t('sidebar.addProject')} onClick={() => void addFolder()}>
        <IconFolderPlus />
      </button>
    </div>
  );
  const projectsSection = (
    <div className="ck-group" key="projects">
      {sectionBar}
      {asks > 0 && questionsRow(asks)}
      <ReorderList
        zoneId="sidebar-projects"
        kind="project"
        axis="y"
        className="ck-projlist"
        items={(box) =>
          Array.from(box.children).flatMap((proj) => {
            const handle = proj.querySelector(':scope > .ck-proj-drag');
            const id = handle?.getAttribute('data-reorder-id');
            return id ? [{ id, el: proj }] : [];
          })
        }
        keyboardId={(el) => el.closest('.ck-proj-drag')?.getAttribute('data-reorder-id') ?? null}
        label={(key) => projectGroups.find((g) => g.key === key)?.name ?? key}
        onMove={(key, slot, keys) => {
          const next = moveToSlot(keys, key, slot);
          reorderProjects(next.flatMap((k) => projectGroups.find((g) => g.key === k)?.path ?? []));
        }}
      >
      {projectGroups.map((g) => {
        const count = g.items.reduce((n, item) => n + 1 + descendants(item).length, 0);
        const isFolded = foldedProjects.has(g.key);
        const ids = g.items.map((item) => item.pane.info.id);
        const everyPane = g.items.flatMap((item) => [item.pane, ...descendants(item).map((d) => d.pane)]);
        const asksHere = (p: Pane) => p.status === 'waiting_input' || questionPanes.has(p.info.id);
        const signal: ProjectSignal = everyPane.some(asksHere)
          ? 'needs'
          : everyPane.some((p) => p.status === 'error')
            ? 'error'
            : everyPane.some((p) => p.status === 'running')
              ? 'working'
              : null;
        const branchGroups = groupByBranch(g.items, (n) => n.pane.info.id, cards);
        const mainBranch = primaryBranch(ids, cards);
        return (
          <div className="ck-proj" key={g.key} role="group" aria-label={g.name} data-pane-ids={g.items.flatMap((item) => [item.pane.info.id, ...descendants(item).map((d) => d.pane.info.id)]).join(' ')}>
            <div className="ck-proj-drag" data-reorder-id={g.added ? g.key : undefined} {...(g.added ? dragSourceProps({ kind: 'project', id: g.key, label: g.name }) : {})}>
            <ProjectHeader
              name={g.name}
              count={count}
              folded={isFolded}
              needs={everyPane.some((p) => asksHere(p) || p.status === 'error')}
              changes={projectChanges(ids, cards)}
              agents={g.items.map((item) => ({ id: item.pane.info.id, agentType: item.pane.info.agent_type, label: c.launchEntries.find((e) => e.type === item.pane.info.agent_type)?.label }))}
              signal={signal}
              added={g.added}
              hasFolder={g.path !== null}
              onToggle={() => toggleProject(g.key)}
              onNewAgent={() => g.path && newAgentIn(g.path, g.name)}
              onAdd={() => g.path && addProject(g.path)}
              onRemove={() => g.path && removeProject(g.path, g.name)}
              onRename={(name) => g.path && renameProject(g.path, name)}
            />
            </div>
            {!isFolded && !branchGroups && mainBranch && <ProjectMeta branch={mainBranch} />}
            {!isFolded && g.path && looseGroup(placement.loose.get(folderKey(g.path) ?? '') ?? [])}
            {!isFolded &&
              (g.items.length > 0 ? (
                <ReorderList
                  zoneId={`sidebar-chats-${g.key}`}
                  kind="chat"
                  axis="y"
                  className="ck-proj-kids"
                  accepts={(p) => ids.includes(p.id)}
                  items={(box) => chatItems(box, ids)}
                  keyboardId={(el) => {
                    const id = rowIdOf(el);
                    return id !== null && ids.includes(id) ? id : null;
                  }}
                  label={(id) => paneTitle(g.items.find((n) => n.pane.info.id === id)?.pane ?? list[0])}
                  onMove={(id, slot, visible) => setGroupOrder(moveToSlot(visible, id, slot))}
                >
                  {branchGroups
                    ? branchGroups.map((bg) => (
                        <div className="ck-branch-group" key={bg.key} role="group" aria-label={bg.label || t('sidebar.projectFolder')}>
                          <div className="ck-branch-head">
                            <span className="ck-proj-branch" title={bg.label}>
                              {bg.label || t('sidebar.noBranch')}
                            </span>
                            <span className="ck-pill-quiet">{bg.copy ? t('sidebar.copy') : t('sidebar.primary')}</span>
                            {bg.pr && <span className="ck-branch-pr">{bg.pr}</span>}
                          </div>
                          {bg.items.map(node)}
                        </div>
                      ))
                    : g.items.map(node)}
                </ReorderList>
              ) : g.path ? (
                <button type="button" className="ck-proj-newrow" data-testid="proj-new-agent" onClick={() => g.path && newAgentIn(g.path, g.name)}>
                  {t('sidebar.newAgent')}
                </button>
              ) : (
                <p className="ck-proj-empty">{t('sidebar.noAgents')}</p>
              ))}
          </div>
        );
      })}
      </ReorderList>
      <button type="button" data-testid="side-add-project" className="ck-side-new ck-side-add" onClick={() => void addFolder()}>
        <span className="ck-row-glyph ck-row-glyph--icon">
          <IconFolderPlus />
        </span>
        <span className="ck-row-main">
          <span className="ck-row-title">{t('sidebar.addProject')}</span>
        </span>
      </button>
    </div>
  );

  // The row menu's extras: "Add a helper" on an agent, "Keep as standby" on a finished helper.
  const menuPane = rowMenu ? list.find((p) => p.info.id === rowMenu.id) : undefined;
  const menuParent = rowMenu ? liveParentId(list, rowMenu.id) : null;
  const keepOnStandby = (p: Pane, home: string) =>
    void standbyApi
      .add({ name: paneTitle(p), agent: p.info.agent_type, model: null, project: p.info.cwd ?? '', after_task: 'wait', home })
      .then((next) => {
        applyStandby(next);
        c.notify(t('standby.kept', { name: paneTitle(p) }));
      })
      .catch((e) => c.notify(errorSentence(e)));
  // The key of a shortcut as the person set it (CockpitApp draws again when they change it).
  const hint = (id: string) => (isMacPlatform() ? bindingLabel(id) : bindingLabel(id).replace('+', ' '));
  return (
    <aside ref={sideRef} className={`ck-side${folderDrop.over ? ' is-file-over' : ''}`} aria-label={t('sidebar.agentsLabel')}>
      {setUpFor && (
        <AddChatDialog
          agent={setUpFor.agent}
          prefer={setUpFor.prefer}
          api={acp}
          onClose={() => setSetUpFor(null)}
          onAdded={() => {
            // The chat is added: start it, as the menu would have.
            const { agent } = setUpFor;
            setSetUpFor(null);
            startAcpChat(agent.id).catch((err: unknown) => c.notify(errorSentence(err)));
          }}
        />
      )}
      <div className="ck-side-head">
        <PotatoMark size={18} className="ck-potato" />
        <span className="ck-wordmark">Potato Workspace</span>{/* i18n-ok: brand name */}
      </div>

      <div className="ck-side-top">
        <div className="ck-menu-wrap" ref={menuRef}>
          <button
            type="button"
            data-testid="side-new-agent"
            className={`ck-side-new ck-side-new--primary ck-side-new--split${newAgentOpen ? ' is-active' : ''}`}
            onClick={() => (onOpenNewAgent ? onOpenNewAgent() : setMenuOpen((v) => !v))}
            aria-label={t('sidebar.newAgent')}
            title={hint('new-agent')}
          >
            <span className="ck-row-glyph ck-row-glyph--icon">
              <IconNewAgent />
            </span>
            <span className="ck-row-main">
              <span className="ck-row-title">{t('sidebar.newAgent')}</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="side-new-agent-menu"
            className="ck-side-new-chev"
            aria-label={t('sidebar.quickStartMenu')}
            title={t('sidebar.quickStart')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconChevronDown />
          </button>
          {menuOpen && (
            <div className="ck-menu ck-menu--left ck-menu--wide" role="menu">
              <NewAgentWhere
                where={
                  devices?.where
                    ? { ...devices.where, onAddDevice: () => (setMenuOpen(false), devices.where!.onAddDevice()), onStarted: (d, id, chat) => (setMenuOpen(false), devices.where!.onStarted(d, id, chat)) }
                    : undefined
                }
              >
              <NewAgentMenu
                entries={c.launchEntries}
                readyAgents={c.readyAgents}
                onStart={(agent, account) => {
                  const copy = isolated && supportsCopies(project?.state);
                  void (project ? c.newAgent(agent, account, copy, project.path) : c.newAgent(agent, account, copy));
                }}
                onClose={() => setMenuOpen(false)}
                chat={
                  laneView?.labs_enabled
                    ? {
                        mode: startMode,
                        onMode: setStartMode,
                        agents: chatAgents,
                        canAdd: addableAgents,
                        terminalChat: terminalChatAgents,
                        addons,
                        resolve: acp.overlayResolve,
                        onStartTerminal: async (agentId, accountId) => {
                          if (!project) throw new Error('Pick a project folder first.');
                          const paneId = await startTerminalChat(agentId, project.path, accountId);
                          c.select(paneId);
                          requestChatTab(paneId);
                        },
                        onAddChat: (agent, prefer) => {
                          setMenuOpen(false);
                          setSetUpFor({ agent, prefer });
                        },
                        onStart: startAcpChat,
                      }
                    : undefined
                }
                project={project}
                onProject={setChosen}
                pick={tauriPickApi}
                isolated={isolated}
                onIsolated={(on) => {
                  setStored(on);
                  writeCopyPreference(projectKey, on);
                }}
                ship={ship}
                onOpenStore={
                  onOpenStore
                    ? () => {
                        setMenuOpen(false);
                        onOpenStore();
                      }
                    : undefined
                }
                onStartMission={
                  missionsOn && project
                    ? () => {
                        setMenuOpen(false);
                        setMissionFor(project);
                      }
                    : undefined
                }
                onTonight={
                  nightOn
                    ? () => {
                        setMenuOpen(false);
                        setTonightOpen(true);
                      }
                    : undefined
                }
              />
              </NewAgentWhere>
            </div>
          )}
        </div>
        <button type="button" data-testid="side-search" className="ck-side-new" onClick={onOpenPalette}>
          <span className="ck-row-glyph ck-row-glyph--icon">
            <IconSearch />
          </span>
          <span className="ck-row-main">
            <span className="ck-row-title">{t('sidebar.search')}</span>
          </span>
          <kbd className="ck-chip-key ck-row-hint">{hint('palette')}</kbd>
        </button>
      </div>


      <nav className="ck-side-scroll">
        {companions &&
          companions.map((companion) => (
            <CompanionRow
              key={companion.id}
              companion={companion}
              mood={companionMood({
                state: companion.state,
                waiting,
                waitingName,
                working: workingCount,
                agents: panes.length,
                notes: companion.pendingMemory,
                justFinished,
                hour,
                body: companion.body,
              })}
              active={openCompanionId === companion.id}
              onOpen={() => onOpenCompanion?.(companion.id)}
              showDefault={companions.length > 1}
            />
          ))}
        {companions && companions.length > 0 && companions.length < MAX_COMPANIONS && onNewCompanion && (
          <NewCompanionRow onNew={onNewCompanion} />
        )}
        <button
          type="button"
          className={`ck-row ck-row--flat${c.selectedId === null && !c.spawn && !openCompanionId && !newAgentOpen && !spacesOpen && !team?.open ? ' is-active' : ''}`}
          onClick={() => {
            c.select(null);
            onOpenInbox?.();
          }}
        >
          <span className="ck-row-glyph ck-row-glyph--icon">
            <IconInbox />
          </span>
          <span className="ck-row-main">
            <span className="ck-row-title">{t('sidebar.inbox')}</span>
          </span>
          {waiting > 0 && <span className="ck-count">{waiting}</span>}
        </button>
        {team && onOpenTeam && (
          <button type="button" data-testid="side-team" className={`ck-row ck-row--flat${team.open ? ' is-active' : ''}`} onClick={onOpenTeam}>
            <span className="ck-row-glyph ck-row-glyph--icon">
              <IconTeam />
            </span>
            <span className="ck-row-main">
              <span className="ck-row-title">{t('teamHub.side')}</span>
            </span>
            {team.waiting > 0 && (
              <span className="ck-count" data-testid="side-team-count">
                {team.waiting}
              </span>
            )}
          </button>
        )}
        {devices &&devices.groups.length > 0 && (
          <div className="dev-group-head dev-group-head--this" data-testid="this-pc-head">
            <span>{t('devices.thisPc')}</span>
          </div>
        )}
        <PinnedGroup
          ids={pinnedNodes.map((n) => n.pane.info.id)}
          canPin={(id) => roots.some((n) => n.pane.info.id === id)}
          onPlace={(id, slot, visible) => placePin(id, slot, visible)}
          labelOf={(id) => paneTitle(list.find((p) => p.info.id === id) ?? list[0])}
        >
          {pinnedNodes.map(node)}
        </PinnedGroup>
        {groupBy === 'projects' ? (
          projectsSection
        ) : (
          <>
            {sectionBar}
            {section(t('sidebar.needsYou'), groups.needs, waiting, asks)}
            {section(t('sidebar.working'), groups.working)}
            {section(t('sidebar.idle'), groups.idle)}
            {looseGroup([...placement.loose.values()].flat())}
          </>
        )}
        {list.length === 0 && c.registry.initialReady && (
          <>
            <div className="ck-side-empty" data-testid="side-empty">
              <PotatoMark size={28} className="ck-potato ck-potato--quiet" />
              <p>{t('sidebar.noAgentsRunning')}</p>
            </div>
            <BringChatsLink className="bc-link ck-side-bring" label={t('sidebar.bringChats')} />
          </>
        )}
        {companions?.length === 0 && onNewCompanion && <MakeCompanionRow onMake={onNewCompanion} />}
        {closedChats.length > 0 && (
          <button type="button" data-testid="side-closed-chats" className="ck-side-new ck-side-add" onClick={() => setClosedOpen(true)}>
            <span className="ck-row-glyph ck-row-glyph--icon">
              <IconClosedChats />
            </span>
            <span className="ck-row-main">
              <span className="ck-row-title">{t('sidebar.closedChats')}</span>
            </span>
            <span className="ck-side-count">{closedChats.length}</span>
          </button>
        )}
        {devices && devices.groups.length > 0 && <DeviceGroups groups={devices.groups} selectedKey={devices.selectedKey} onOpen={devices.onOpen} onRetry={devices.onRetry} />}
      </nav>

      {hand.status && (
        <div className={`ck-handoff${hand.status.kind === 'failed' ? ' is-failed' : ''}`} role="status" data-testid="handoff-status">
          <span className="ck-handoff-text">{hand.status.text}</span>
          {hand.status.kind === 'saved' && (
            <button
              type="button"
              className="ck-handoff-x"
              data-testid="handoff-open-file"
              onClick={() => void openHandoffFile((hand.status as { paneId: string }).paneId).catch(() => c.notify(t('sidebar.openHandoffFailed')))}
            >
              {t('sidebar.openFile')}
            </button>
          )}
          {!handoffBusy && (
            <button type="button" className="ck-handoff-x" aria-label={t('sidebar.dismiss')} onClick={hand.dismiss}>
              ×
            </button>
          )}
        </div>
      )}

      {rowMenu && (
        <PaneContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onSide={onOpenToSide ? () => onOpenToSide(rowMenu.id) : undefined}
          onLeft={onOpenToSide && onOpenPlaced ? () => onOpenPlaced(rowMenu.id, 'left') : undefined}
          onBelow={onOpenToSide && onOpenPlaced ? () => onOpenPlaced(rowMenu.id, 'down') : undefined}
          pinned={pinSet.has(rowMenu.id)}
          onPin={() => setPinned(rowMenu.id, !pinSet.has(rowMenu.id))}
          onHandoff={hand.allowed(rowMenu.id) && !handoffBusy ? () => hand.start(rowMenu.id) : undefined}
          onPotato={companions && companions.length > 0 ? () => requestPotatoCheck(rowMenu.id) : undefined}
          helperOf={adopt.targets(rowMenu.id)}
          onHelperOf={(parentId) => void adopt.adopt(rowMenu.id, parentId)}
          helperName={adoptName(rowMenu.id)}
          onMainAgain={adopt.isHelper(rowMenu.id) ? () => void adopt.release(rowMenu.id) : undefined}
          onPassTask={canPassTask ? () => requestPassTask({ repoPath: c.registry.panes.get(rowMenu.id)?.info.cwd ?? null, summary: chatSummaryOf(rowMenu.id) }) : undefined}
          onAddHelper={menuPane && !menuParent && menuPane.info.cwd ? () => openNewStandby(menuPane.info.cwd, rowMenu.id, { x: rowMenu.x + 8, y: rowMenu.y }) : undefined}
          onKeepStandby={menuPane && menuParent && menuPane.status !== 'running' && menuPane.info.cwd ? () => keepOnStandby(menuPane, menuParent) : undefined}
          onAction={(action) => runPaneAction(rowMenu.id, action)}
          onInterrupt={() => void c.interrupt(rowMenu.id)}
          onClose={closeRowMenu}
        />
      )}

      {showHelperTree && <SidebarWarmLine rows={placement.warm} renderRow={standbyRowView} />}

      <SidebarFooter
        names={c.names}
        onOpenPane={(id) => c.select(id)}
        mode={c.mode}
        onMode={(m) => void c.setMode(m)}
        theme={c.theme}
        onToggleTheme={() => void c.toggleTheme()}
        onSetTheme={(next) => void c.setThemeChoice(next)}
        helpersOf={(id) => helperRows(c.registry.paneList, id, (p) => c.names.get(p.info.id) ?? p.info.agent_type)}
        onStopHelper={(id) => c.interrupt(id)}
        onOpenSettings={(tab) => void (tab ? c.openSettings(tab) : c.openSettings())}
        bridgeLine={c.bridgeLine}
        onOpenDoctor={onOpenDoctor}
        onOpenMemory={onOpenMemory}
        onOpenPlans={onOpenPlans}
        onOpenScores={onOpenScores}
        onOpenReview={onOpenReview}
        reviewCount={reviewCount}
        onOpenMorning={onOpenMorning}
        onOpenRoutines={onOpenRoutines}
        spacesEnabled={spaces?.enabled}
        spacesOpen={spacesOpen}
        onOpenSpaces={onOpenSpaces}
        onOpenToday={onOpenToday}
        todayOpen={todayOpen}
      />
      {closedOpen && (
        <ClosedChatsSheet
          chats={closedChats}
          api={closedChatsApi}
          notify={c.notify}
          onChanged={reloadClosed}
          onReopened={(paneId) => {
            setClosedOpen(false);
            c.select(paneId);
          }}
          onClose={() => setClosedOpen(false)}
        />
      )}
      {tonightOpen && nightOn && (
        <TonightHost
          c={c}
          onClose={() => setTonightOpen(false)}
          onStarted={() => c.notify(t('sidebar.nightShiftSet'))}
        />
      )}
      {missionFor && (
        <StartMissionSheet
          project={{ path: missionFor.path, name: missionFor.name, git: supportsCopies(missionFor.state) }}
          entries={c.launchEntries}
          activeMissions={missions.missions.filter(isActive).length}
          onClose={() => setMissionFor(null)}
          onStarted={() => {
            setMissionFor(null);
            missions.reload();
            c.notify(t('sidebar.missionStarted'));
          }}
        />
      )}
      {folderDrop.over && (
        <div className="ck-side-dropnote" aria-hidden="true">
          {t('dnd.dropFolder')}
        </div>
      )}
      {folderDrop.pending && <DropFolderSheet path={folderDrop.pending} onAdd={addProject} onClose={folderDrop.clear} />}
    </aside>
  );
}
