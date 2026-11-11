import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PaneContextMenu } from './PaneContextMenu';
import type { HandoffDeps } from '../../lib/handoff';
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
import { IconChevronDown, IconClosedChats, IconFolderPlus, IconGlobe, IconInbox, IconMore, IconNewAgent, IconPin, IconSearch, IconSort } from './Icons';
import { RowMark } from './RowMark';
import { ProjectHeader } from './ProjectHeader';
import { SidebarFooter } from './SidebarFooter';
import { bindingLabel, isMacPlatform } from '../../lib/shortcuts';
import { groupByProject, useFoldedProjects, useGroupBy, useSidebarProjects } from '../../lib/sidebarProjects';
import { formatElapsed, spinnerStatus } from './model';
import { splitPinned, usePinnedPanes } from '../../lib/pinnedPanes';
import { descendants, groupHelperTree, helperChipText, readFoldedParents, writeFoldedParents, type HelperNode } from '../../lib/pane-helpers';
import { multiLoginAgents, paneHeading, paneSubline } from './titles';
import { LastTurnContext } from './away-context';
import { projectWithCopy } from './shell-labels';
import type { CompanionView } from '../../lib/companion';
import { CompanionRow, MakeCompanionRow } from './companion/CompanionRow';
import { isCompanionPaneId } from './companion/model';
import { useReviewCount } from './review/useReviewCount';
import { FocusPill } from './FocusPill';
import { ClosedChatsSheet } from './ClosedChatsSheet';
import { tauriClosedChatsApi, useClosedChats, type ClosedChatsApi } from '../../lib/closedChats';

/** `localhost:5173`: where the preview is, without the scheme. */
const previewAddress = (p: PreviewUrl): string => p.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
import { StartMissionSheet } from './mission/StartMissionSheet';
import { onOpenStartMission, useMissions, useMissionsEnabled, isActive } from '../../lib/missions';
import { TonightHost } from './night/TonightHost';
import { onOpenTonight } from '../../lib/night-host';
import { useNightEnabled } from '../../lib/night';

export function Sidebar({
  c,
  onOpenPalette,
  onOpenDoctor,
  onOpenMemory,
  onOpenPlans,
  onOpenScores,
  onOpenReview,
  onOpenMorning,
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
  onOpenToSide,
  onPaneAction,
  ship = shipApi,
  acp = tauriAcpChatApi,
  addons = tauriAcpAddonApi,
  startModeApi = settingsStartModeApi,
  closedChatsApi = tauriClosedChatsApi,
  handoffDeps,
  handoff,
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
  /** The "More agents…" row of the New agent menu opens the Agent Store. Absent: no row. */
  onOpenStore?: () => void;
  /** The pane row menu's "Open to the side" (split view). Absent: the menu has no such item. */
  onOpenToSide?: (paneId: string) => void;
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
  ship?: ShipApi;
  /** Chat sessions (ACP): which agents can run as a chat, and starting one. Replaceable in tests. */
  acp?: AcpChatApi;
  /** The chat add-ons (status, install). Replaceable in tests. */
  addons?: AcpAddonApi;
  /** Where the New agent menu's Chat | Terminal choice is saved. Replaceable in tests. */
  startModeApi?: StartModeApi;
  /** The closed chats (list, reopen, delete). Replaceable in tests. */
  closedChatsApi?: ClosedChatsApi;
  /** The calls "Handoff from here" makes. Replaceable in tests. */
  handoffDeps?: HandoffDeps;
  /** The cockpit's shared handoff (also used by the pane's "Hand off" button). Absent: the sidebar keeps its own. */
  handoff?: HandoffControl;
}) {
  const list = c.registry.paneList;
  // Closed chats: read again whenever the set of panes changes (a chat was closed or reopened).
  const { chats: closedChats, reload: reloadClosed } = useClosedChats(closedChatsApi, list.map((p) => p.info.id).join('|'));
  const [closedOpen, setClosedOpen] = useState(false);
  // `Review 4`: how many finished things wait to be looked at. Hidden at 0.
  const reviewCount = useReviewCount(onOpenReview !== undefined);
  // A companion's pane has its own companion row above; it is not listed again as a plain pane.
  const panes = list.filter((p) => !isCompanionPaneId(p.info.id));
  // The same list the Inbox badge and the Doto counter use, so the three numbers always agree.
  const needs = useNeedsYou(c);
  const questionPanes = needsYouPaneIds(needs);
  const grouped = groupHelperTree(panes, questionPanes);
  // Pinned chats sit in their own group at the top, newest pin first, whatever they are doing.
  const { pins, setPinned } = usePinnedPanes();
  const pinSet = new Set(pins);
  const roots = [...grouped.needs, ...grouped.working, ...grouped.idle].filter((n) => !n.awayFrom);
  const { pinned: pinnedNodes } = splitPinned(roots, (n) => n.pane.info.id, pins);
  const pinnedIds = new Set(pinnedNodes.map((n) => n.pane.info.id));
  const unpinned = (items: typeof grouped.needs) => items.filter((n) => n.awayFrom || !pinnedIds.has(n.pane.info.id));
  const groups = { needs: unpinned(grouped.needs), working: unpinned(grouped.working), idle: unpinned(grouped.idle) };
  // Projects view: the folders the person added, which groups are folded, and how the list is grouped.
  const { projects, add: addProject, remove: removeProject, rename: renameProject } = useSidebarProjects();
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
  // Questions agents asked through ask_user: they belong to no pane row, so they get a row of their own.
  const asks = itemsOfKind(blockingItems(needs), 'question').length;
  const multiLogin = multiLoginAgents(list.map((p) => p.info));
  const lastTurn = useContext(LastTurnContext);
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
  const startAcpChat = async (agentId: string) => {
    if (!project) throw new Error('Pick a project folder first.');
    const started = await acp.start(agentId, project.path, true);
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

  useEffect(() => {
    if (!menuOpen) return;
    const away = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  type Pane = (typeof list)[number];
  const paneTitle = (p: Pane) => paneHeading(p.info, c.names.get(p.info.id) ?? p.info.agent_type).primary;
  const row = (p: Pane, awayFrom?: Pane) => {
    const id = p.info.id;
    const since = c.statusSince.get(id);
    const active = c.selectedId === id && !c.spawn && !openCompanionId;
    const heading = paneHeading(p.info, c.names.get(id) ?? p.info.agent_type);
    const detail =
      activityText(p.status, c.activities?.[id]) ??
      (p.status === 'error' ? `Error · ${projectWithCopy(p.info.cwd)}` : projectWithCopy(p.info.cwd));
    const subline = paneSubline(
      p.info,
      c.names.get(id) ?? p.info.agent_type,
      // Away from its parent (in Needs you) a helper says whose it is.
      awayFrom ? `Helper of ${paneTitle(awayFrom)} · ${detail}` : detail,
      multiLogin,
    );
    const entry = c.launchEntries.find((e) => e.type === p.info.agent_type);
    const asking = p.status === 'waiting_input' || questionPanes.has(id);
    const pill = asking && p.status !== 'error';
    const preview = mainPreview(c.previews, id);
    return (
      <div key={id} className="ck-rowwrap">
        <button
          type="button"
          data-pane-row={id}
          className={`ck-row ck-row--slim${active ? ' is-active' : ''}${asking ? ' is-needs' : ''}${p.status === 'error' ? ' is-error' : ''}`}
          onClick={() => c.select(id)}
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
          aria-label={pill ? `${heading.primary}, needs you` : undefined}
        >
          <span className="ck-row-glyph">
            <RowMark status={p.status} asking={asking && p.status !== 'error'} />
          </span>
          <span className="ck-row-main" title={[...new Set([heading.primary, entry?.label, subline, projectWithCopy(p.info.cwd)])].filter(Boolean).join(' · ')}>
            <span className="ck-row-title">{heading.primary}</span>
            <span className="ck-row-sub">{subline}</span>
          </span>
          {preview && (
            <span className="ck-row-preview" title={`Has a preview · ${previewAddress(preview)}`} role="img" aria-label="Has a preview">
              <IconGlobe />
            </span>
          )}
          {pinSet.has(id) && (
            <span className="ck-row-pin" role="img" aria-label="Pinned" title="Pinned">
              <IconPin />
            </span>
          )}
          {pill ? (
            <span className="ck-row-pill">Needs you</span>
          ) : (
            <span className="ck-row-time">{since ? formatElapsed(c.now - since) : ''}</span>
          )}
        </button>
        <button
          type="button"
          className="ck-row-more"
          aria-label={`More for ${heading.primary}`}
          title="More"
          aria-haspopup="menu"
          onClick={(e) => {
            rowMenuFrom.current = e.currentTarget;
            const r = e.currentTarget.getBoundingClientRect();
            setRowMenu({ id, x: r.left, y: r.bottom + 2 });
          }}
        >
          <IconMore />
        </button>
      </div>
    );
  };
  // A row, and under it its helpers: indented behind a thin guide line, folded by the "N helpers" chip.
  const node = (n: HelperNode<Pane>): JSX.Element => {
    const id = n.pane.info.id;
    if (n.helpers.length === 0) return row(n.pane, n.awayFrom);
    const open = !folded.has(id);
    return (
      <div key={id} className="ck-node">
        {row(n.pane, n.awayFrom)}
        <div className="ck-helpers" role="group" aria-label={`Helpers of ${paneTitle(n.pane)}`}>
          <button
            type="button"
            className="ck-helper-chip"
            onClick={() => toggleFolded(id)}
            aria-expanded={open}
            title={open ? 'Hide helpers' : 'Show helpers'}
          >
            {helperChipText(n)}
            <span className={`ck-helper-caret${open ? ' is-open' : ''}`} aria-hidden="true" />
          </button>
          {open && n.helpers.map(node)}
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
        <span className="ck-row-title">Questions from agents</span>
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
  const projectRoots = roots.filter((n) => !pinnedIds.has(n.pane.info.id));
  const projectGroups = groupByProject(projectRoots, (n) => n.pane.info.cwd, projects);
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
      c.notify('Could not open the folder picker here.');
    }
  };
  const sectionBar = (
    <div className="ck-sechead">
      <span className="ck-sechead-text">{groupBy === 'projects' ? 'Projects' : 'Status'}</span>
      <button
        type="button"
        className="ck-sechead-btn"
        aria-label={groupBy === 'projects' ? 'Group by status' : 'Group by project'}
        title={groupBy === 'projects' ? 'Group by status (Needs you, Working, Idle)' : 'Group by project folder'}
        onClick={() => setGroupBy(groupBy === 'projects' ? 'status' : 'projects')}
      >
        <IconSort />
      </button>
      <button type="button" className="ck-sechead-btn" data-testid="side-add-project-btn" aria-label="Add project" title="Add project" onClick={() => void addFolder()}>
        <IconFolderPlus />
      </button>
    </div>
  );
  const projectsSection = (
    <div className="ck-group" key="projects">
      {sectionBar}
      {asks > 0 && questionsRow(asks)}
      {projectGroups.map((g) => {
        const count = g.items.reduce((n, item) => n + 1 + descendants(item).length, 0);
        const isFolded = foldedProjects.has(g.key);
        return (
          <div className="ck-proj" key={g.key} role="group" aria-label={g.name} data-pane-ids={g.items.flatMap((item) => [item.pane.info.id, ...descendants(item).map((d) => d.pane.info.id)]).join(' ')}>
            <ProjectHeader
              name={g.name}
              count={count}
              folded={isFolded}
              needs={g.items.some((n) => n.pane.status === 'waiting_input' || n.pane.status === 'error' || questionPanes.has(n.pane.info.id))}
              added={g.added}
              hasFolder={g.path !== null}
              onToggle={() => toggleProject(g.key)}
              onNewAgent={() => g.path && newAgentIn(g.path, g.name)}
              onAdd={() => g.path && addProject(g.path)}
              onRemove={() => g.path && removeProject(g.path)}
              onRename={(name) => g.path && renameProject(g.path, name)}
            />
            {!isFolded &&
              (g.items.length > 0 ? (
                <div className="ck-proj-kids">{g.items.map(node)}</div>
              ) : g.path ? (
                <button type="button" className="ck-proj-newrow" data-testid="proj-new-agent" onClick={() => g.path && newAgentIn(g.path, g.name)}>
                  New agent
                </button>
              ) : (
                <p className="ck-proj-empty">No agents</p>
              ))}
          </div>
        );
      })}
      <button type="button" data-testid="side-add-project" className="ck-side-new ck-side-add" onClick={() => void addFolder()}>
        <span className="ck-row-glyph ck-row-glyph--icon">
          <IconFolderPlus />
        </span>
        <span className="ck-row-main">
          <span className="ck-row-title">Add project</span>
        </span>
      </button>
    </div>
  );

  // The key of a shortcut as the person set it (CockpitApp draws again when they change it).
  const hint = (id: string) => (isMacPlatform() ? bindingLabel(id) : bindingLabel(id).replace('+', ' '));
  return (
    <aside className="ck-side" aria-label="Agents">
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
        <span className="ck-wordmark">Potato Workspace</span>
      </div>

      <FocusPill notify={c.notify} />

      <div className="ck-side-top">
        <div className="ck-menu-wrap" ref={menuRef}>
          <button
            type="button"
            data-testid="side-new-agent"
            className={`ck-side-new ck-side-new--primary ck-side-new--split${newAgentOpen ? ' is-active' : ''}`}
            onClick={() => (onOpenNewAgent ? onOpenNewAgent() : setMenuOpen((v) => !v))}
            aria-label="New agent"
            title={hint('new-agent')}
          >
            <span className="ck-row-glyph ck-row-glyph--icon">
              <IconNewAgent />
            </span>
            <span className="ck-row-main">
              <span className="ck-row-title">New agent</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="side-new-agent-menu"
            className="ck-side-new-chev"
            aria-label="Quick start menu"
            title="Quick start"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <IconChevronDown />
          </button>
          {menuOpen && (
            <div className="ck-menu ck-menu--left ck-menu--wide" role="menu">
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
                        onStartTerminal: async (agentId) => {
                          if (!project) throw new Error('Pick a project folder first.');
                          const paneId = await startTerminalChat(agentId, project.path);
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
            </div>
          )}
        </div>
        <button type="button" data-testid="side-search" className="ck-side-new" onClick={onOpenPalette}>
          <span className="ck-row-glyph ck-row-glyph--icon">
            <IconSearch />
          </span>
          <span className="ck-row-main">
            <span className="ck-row-title">Search</span>
          </span>
          <kbd className="ck-row-hint">{hint('palette')}</kbd>
        </button>
      </div>


      <nav className="ck-side-scroll">
        {companions &&
          (companions.length === 0
            ? onNewCompanion && <MakeCompanionRow onMake={onNewCompanion} />
            : companions.map((companion) => (
                <CompanionRow
                  key={companion.id}
                  companion={companion}
                  active={openCompanionId === companion.id}
                  onOpen={() => onOpenCompanion?.(companion.id)}
                />
              )))}
        <button
          type="button"
          className={`ck-row ck-row--flat${c.selectedId === null && !c.spawn && !openCompanionId && !newAgentOpen && !spacesOpen ? ' is-active' : ''}`}
          onClick={() => {
            c.select(null);
            onOpenInbox?.();
          }}
        >
          <span className="ck-row-glyph ck-row-glyph--icon">
            <IconInbox />
          </span>
          <span className="ck-row-main">
            <span className="ck-row-title">Inbox</span>
          </span>
          {waiting > 0 && <span className="ck-count">{waiting}</span>}
        </button>
        {section('Pinned', pinnedNodes)}
        {groupBy === 'projects' ? (
          projectsSection
        ) : (
          <>
            {sectionBar}
            {section('Needs you', groups.needs, waiting, asks)}
            {section('Working', groups.working)}
            {section('Idle', groups.idle)}
          </>
        )}
        {list.length === 0 && c.registry.initialReady && <p className="ck-side-empty">No agents running.</p>}
        {closedChats.length > 0 && (
          <button type="button" data-testid="side-closed-chats" className="ck-side-new ck-side-add" onClick={() => setClosedOpen(true)}>
            <span className="ck-row-glyph ck-row-glyph--icon">
              <IconClosedChats />
            </span>
            <span className="ck-row-main">
              <span className="ck-row-title">Closed chats</span>
            </span>
            <span className="ck-side-count">{closedChats.length}</span>
          </button>
        )}
      </nav>

      {hand.status && (
        <div className={`ck-handoff${hand.status.kind === 'failed' ? ' is-failed' : ''}`} role="status" data-testid="handoff-status">
          <span className="ck-handoff-text">{hand.status.text}</span>
          {!handoffBusy && (
            <button type="button" className="ck-handoff-x" aria-label="Dismiss" onClick={hand.dismiss}>
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
          pinned={pinSet.has(rowMenu.id)}
          onPin={() => setPinned(rowMenu.id, !pinSet.has(rowMenu.id))}
          onHandoff={hand.allowed(rowMenu.id) && !handoffBusy ? () => hand.start(rowMenu.id) : undefined}
          onAction={(action) => runPaneAction(rowMenu.id, action)}
          onInterrupt={() => void c.interrupt(rowMenu.id)}
          onClose={closeRowMenu}
        />
      )}

      <SidebarFooter
        names={c.names}
        onOpenPane={(id) => c.select(id)}
        mode={c.mode}
        onMode={(m) => void c.setMode(m)}
        theme={c.theme}
        onToggleTheme={() => void c.toggleTheme()}
        onOpenSettings={(tab) => void (tab ? c.openSettings(tab) : c.openSettings())}
        bridgeLine={c.bridgeLine}
        onOpenDoctor={onOpenDoctor}
        onOpenMemory={onOpenMemory}
        onOpenPlans={onOpenPlans}
        onOpenScores={onOpenScores}
        onOpenReview={onOpenReview}
        reviewCount={reviewCount}
        onOpenMorning={onOpenMorning}
        spacesEnabled={spaces?.enabled}
        spacesOpen={spacesOpen}
        onOpenSpaces={onOpenSpaces}
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
          onStarted={() => c.notify('Night Shift is set. The chip below shows how it goes.')}
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
            c.notify('Mission started. It shows in the Inbox while it works.');
          }}
        />
      )}
    </aside>
  );
}
