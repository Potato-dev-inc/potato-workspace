import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { isDarkTheme } from '../../lib/theme-tone';
import { previewLabel } from '../../lib/pane-preview';
import { pointApi } from '../../lib/point-api';
import { agentLabel, useAgentRegistry } from '../../lib/agentRegistry';
import { requestChatJump } from '../../lib/chatJump';
import { requestContentSearch } from '../../lib/files-search-request';
import { requestBringChats, requestImportedChat } from '../../lib/chatImport';
import { liveRoomApi, requestGoLive } from '../../lib/live-room';
import { LiveStatusContext } from './live/useLiveRoom';
import type { ChatHit } from '../../lib/chatSearch';
import { useChatSearch } from '../../hooks/useChatSearch';
import { useChatFacets } from '../../hooks/useChatFacets';
import { dropShortcut, hasChatFilters, mergeChatFilters, parseChatQuery, type ChatFilters } from '../../lib/chatFilters';
import '../../styles/cockpit-chat-search.css';
import { ChatHitDetail, ChatHitRows, SEARCH_CHATS_TITLE } from './ChatHits';
import { bindingLabel } from '../../lib/shortcuts';
import { nextNeedingPane, paneLastUsed, rankPanes, stepPane } from '../../lib/pane-order';
import { NeedsYouContext } from '../../hooks/useNeedsYou';
import { useKeybindingsVersion } from '../../hooks/useKeybindings';
import { ChatFilterChips, type ChipKey } from './ChatFilterChips';
import { T as WELCOME } from '../firstrun/copy';
import { AgentLogo } from '../common/AgentLogo';
import { IconChart, IconInbox, IconClose, IconCopy, IconGlobe, IconInfo, IconLayers, IconMoon, IconNote, IconPlus, IconReflow, IconRename, IconSearch, IconSettings, IconStop, IconSun, IconTerminal, IconTeam } from './Icons';
import { t } from '../../i18n';
import { isCompanionPaneId } from './companion/model';
import { isListedAgentPane } from '../../lib/pane-helpers';
import { useOpenedStandbyPanes } from '../../lib/standbyHelpers';
import { requestPaneAction } from '../../lib/pane-actions';
import { matchesQuery, stateText } from './model';
import { settingsShortcuts } from './palette-shortcuts';
import { useMissionsEnabled } from '../../lib/missions';
import { chatAgentIds } from '../../lib/chatFirst';
import { useShowTerminals } from '../../lib/showTerminals';
import { useAcpLanes } from '../../hooks/useAcpLanes';
import { useNightEnabled } from '../../lib/night';
import { guidePaletteRows, useGuideEnabled } from '../../lib/guide-tabs';
import { projectWithCopy } from './shell-labels';
import { multiLoginAgents, paneHeading, paneSubline } from './titles';
import type { CompanionView } from '../../lib/companion';
import { useT } from '../../i18n';
import { stateWord } from '../../lib/companion';
import { Avatar } from '../companion/Avatar';
import { t as tr } from '../../i18n';
import { isAway, openDeskSheet, useDeskAway } from '../../lib/desk-away';
import { openTour, requestGuide } from '../../whatsnew/store';

interface Item {
  id: string;
  group: 'Panes' | 'New agent' | 'Terminals' | 'Actions';
  title: string;
  desc?: string;
  icon: ReactNode;
  hint?: string;
  /** Extra words that find the row (not shown). */
  keywords?: string;
  run: () => void;
}

const NO_ITEMS: never[] = [];

export type PaletteMode = 'commands' | 'chats';

export function Palette({
  c,
  initialMode = 'commands',
  onClose,
  onOpenDoctor,
  onStopAll,
  onOpenMemory,
  onOpenPlans,
  onOpenMorning,
  onOpenScores,
  onOpenTeam,
  onOpenReview,
  onReviewRiskiest,
  onOpenStore,
  onUndoLastTurn,
  onWhatBroke,
  onOpenWelcome,
  onStartCrew,
  onOpenShortcuts,
  onOpenInbox,
  companions,
  onOpenCompanion,
  onNewCompanion,
}: {
  c: CockpitApi;
  /** `chats`: open straight in "Search all chats" (Ctrl+Shift+F by default). */
  initialMode?: PaletteMode;
  onClose: () => void;
  onOpenDoctor?: () => void;
  onStopAll?: () => void;
  onOpenMemory?: () => void;
  onOpenPlans?: () => void;
  /** Night Shift: opens the Morning page (drawn only while the Labs switch is on). */
  onOpenMorning?: () => void;
  /** Opens "Scores on your code". Absent: no Scores action. */
  onOpenScores?: () => void;
  /** Opens the Team page. Absent: no Team action. */
  onOpenTeam?: () => void;
  /** Opens the Review Desk. Absent: no Review Desk action. */
  onOpenReview?: () => void;
  /** Opens the Review Desk on its first row (the riskiest item). Absent: no such action. */
  onReviewRiskiest?: () => void;
  /** Opens the Agent Store. Absent: no Agent Store action. */
  onOpenStore?: () => void;
  /** Opens the restore confirmation for the pane's last turn (never restores by itself). */
  onUndoLastTurn?: (paneId: string) => void;
  /** Opens "What broke the tests?" for the selected pane. Absent: no row. */
  onWhatBroke?: (paneId: string) => void;
  /** Shows the first-run welcome again. */
  onOpenWelcome?: () => void;
  /** Opens "Start crew": pick a saved team of agents and a folder. */
  onStartCrew?: () => void;
  /** Opens the keyboard shortcuts sheet. */
  onOpenShortcuts?: () => void;
  /** Opens the Inbox. Absent: no Inbox action. */
  onOpenInbox?: () => void;
  /** The companions (null: no companion backend). Each one gets an "Open {name}" row. */
  companions?: CompanionView[] | null;
  onOpenCompanion?: (id: string) => void;
  onNewCompanion?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  // A hit whose pane is gone, shown read-only.
  const [closedHit, setClosedHit] = useState<ChatHit | null>(null);
  const listing = useAgentRegistry();
  // The chips (picked here) and the typed shortcuts (`agent:`, `in:`, `from:`) make one set of filters.
  const [chips, setChips] = useState<ChatFilters>({});
  const facets = useChatFacets(mode === 'chats');
  const parsed = useMemo(() => parseChatQuery(query, facets), [query, facets]);
  const filters = useMemo(() => mergeChatFilters(chips, parsed.typed), [chips, parsed]);
  const chats = useChatSearch(parsed.text, filters, mode === 'chats');
  // A chip picked for a filter takes over from a typed shortcut for it (the shortcut leaves the box).
  const pickChip = (key: ChipKey, value: string | undefined) => {
    setChips((now) => ({ ...now, [key]: value }) as ChatFilters);
    if (key !== 'when') setQuery((now) => dropShortcut(now, key));
  };
  const listRef = useRef<HTMLDivElement>(null);

  const missionsOn = useMissionsEnabled();
  // Terminals hidden: "New <agent>" rows are for agents that can chat, and there are no shell rows.
  const terminals = useShowTerminals();
  const laneView = useAcpLanes(!terminals);
  // The Live Room status the cockpit shares (undefined: no Live Room host, so no Live Room rows).
  const liveStatus = useContext(LiveStatusContext);
  const liveOn = liveStatus?.live === true;
  const nightOn = useNightEnabled();
  const [deskAway, deskStore] = useDeskAway();
  const guideOn = useGuideEnabled();
  // The panes that need you list first, then the one you used last. The hints follow the keys you chose.
  const needsYou = useContext(NeedsYouContext) ?? NO_ITEMS;
  const keysVersion = useKeybindingsVersion();
  const t = useT();
  const openedStandbyPanes = useOpenedStandbyPanes();
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const multiLogin = multiLoginAgents(c.registry.paneList.map((p) => p.info));
    for (const companion of companions ?? []) {
      out.push({
        id: `companion:${companion.id}`,
        group: 'Panes',
        title: t('companions.goTo', { name: companion.name }),
        desc: `Companion · ${stateWord(companion.state)}`,
        keywords: 'companion',
        icon: <Avatar id={companion.avatar} size={16} state={companion.state} name={companion.name} />,
        run: () => onOpenCompanion?.(companion.id),
      });
    }
    const waiting = new Set(needsYou.flatMap((item) => (item.paneId ? [item.paneId] : [])));
    // A standby's own chat and a minion's run are not open agents: they never show as one here (closed ones stay under Closed chats).
    const agentPanes = c.registry.paneList.filter((p) => isListedAgentPane(p.info, openedStandbyPanes));
    const ranked = rankPanes(
      agentPanes.map((p) => ({ id: p.info.id, p })),
      waiting,
      paneLastUsed(),
    ).map((x) => x.p);
    for (const p of ranked) {
      const id = p.info.id;
      if (isCompanionPaneId(id)) continue;
      const agentName = c.names.get(id) ?? p.info.agent_type;
      const heading = paneHeading(p.info, agentName);
      out.push({
        id: `pane:${id}`,
        group: 'Panes',
        title: heading.primary,
        desc: `${paneSubline(p.info, agentName, projectWithCopy(p.info.cwd), multiLogin)} · ${waiting.has(id) ? 'Needs you' : stateText(p.status)}`,
        icon: <AgentLogo id={p.info.agent_type} name={agentName} size={14} decorative />,
        run: () => c.select(id),
      });
    }
    // Plain shells (PowerShell, bash) go in their own group under the agents, not next to them.
    const shellRows: Item[] = [];
    const chatIds = !terminals && laneView?.labs_enabled ? chatAgentIds(laneView) : null;
    for (const e of c.launchEntries) {
      if (e.disabled) continue;
      if (!terminals && e.shell) continue;
      if (chatIds && !chatIds.has(e.type.toLowerCase())) continue;
      const row: Item = {
        id: `new:${e.type}`,
        group: e.shell ? 'Terminals' : 'New agent',
        title: `New ${e.label}`,
        desc: c.readyAgents.has(e.type) ? 'Opens instantly' : undefined,
        icon: <IconPlus />,
        hint: c.readyAgents.has(e.type) ? 'ready' : undefined,
        run: () => void c.newAgent(e.type),
      };
      if (e.shell) shellRows.push(row);
      else out.push(row);
    }
    if (onNewCompanion) {
      out.push({
        id: 'new:companion',
        group: 'New agent',
        title: 'New companion',
        desc: t('companion.newDesc'),
        keywords: 'companion assistant helper',
        icon: <IconPlus />,
        run: onNewCompanion,
      });
    }
    out.push(...shellRows);
    // Moving around: the same actions as the keys, with the keys you chose shown on the right.
    const listed = agentPanes.map((p) => p.info.id).filter((id) => !isCompanionPaneId(id));
    if (onOpenInbox) {
      out.push({ id: 'act:inbox', group: 'Actions', title: 'Open the Inbox', desc: 'Everything that is waiting for you', keywords: 'inbox needs you waiting cards', icon: <IconInbox />, hint: bindingLabel('open-inbox') || undefined, run: onOpenInbox });
    }
    if (waiting.size > 0) {
      const target = nextNeedingPane(listed, waiting, c.selectedId);
      if (target) out.push({ id: 'act:next-needs-me', group: 'Actions', title: 'Jump to the next agent that needs you', keywords: 'needs me waiting next approval question', icon: <IconInbox />, hint: bindingLabel('next-needs-me') || undefined, run: () => c.select(target) });
    }
    if (listed.length > 1) {
      const next = stepPane(listed, c.selectedId, 1);
      const prev = stepPane(listed, c.selectedId, -1);
      if (next) out.push({ id: 'act:pane-next', group: 'Actions', title: 'Next agent', keywords: 'next pane switch down', icon: <IconTerminal />, hint: bindingLabel('pane-next') || undefined, run: () => c.select(next) });
      if (prev) out.push({ id: 'act:pane-prev', group: 'Actions', title: 'Previous agent', keywords: 'previous pane switch up back', icon: <IconTerminal />, hint: bindingLabel('pane-prev') || undefined, run: () => c.select(prev) });
    }
    if (c.selectedId && c.registry.panes.has(c.selectedId)) {
      const sel = c.selectedId;
      out.push({
        id: 'act:interrupt',
        group: 'Actions',
        title: 'Stop this agent',
        desc: c.names.get(sel),
        icon: <IconStop />,
        hint: '⌃C',
        run: () => void c.interrupt(sel),
      });
      // The pane menu's actions (the sidebar row's right-click menu has the same ones), for the selected pane.
      const paneActions = [
        { id: 'rename', title: 'Rename this agent', icon: <IconRename />, keywords: 'rename title name' },
        { id: 'reflow', title: 'Reflow the terminal', icon: <IconReflow />, keywords: 'reflow redraw garbled fix layout resize' },
        { id: 'copy', title: 'Copy selection', icon: <IconCopy />, keywords: 'copy selection clipboard' },
        { id: 'details', title: 'Agent details', icon: <IconInfo />, keywords: 'details info about' },
        { id: 'close', title: 'Close this agent', icon: <IconClose />, keywords: 'close end quit remove' },
      ] as const;
      for (const a of paneActions) {
        out.push({
          id: `act:${a.id}`,
          group: 'Actions',
          title: a.title,
          desc: c.names.get(sel),
          keywords: a.keywords,
          icon: a.icon,
          run: () => requestPaneAction(sel, a.id),
        });
      }
      for (const row of guidePaletteRows(guideOn)) {
        out.push({ id: row.id, group: 'Actions', title: row.title, desc: c.names.get(sel), keywords: row.keywords, icon: <IconInfo />, run: () => requestPaneAction(sel, 'guide') });
      }
      if (onUndoLastTurn) {
        out.push({
          id: 'act:undo',
          group: 'Actions',
          title: 'Undo last turn…',
          desc: 'Restore files to before the last turn. The agent keeps its memory.',
          icon: <IconReflow />,
          run: () => onUndoLastTurn(sel),
        });
      }
      if (onWhatBroke) {
        out.push({
          id: 'act:whatbroke',
          group: 'Actions',
          title: 'Find what broke the tests…',
          desc: "Look back through the agents' turns.",
          icon: <IconSearch />,
          run: () => onWhatBroke(sel),
        });
      }
    }
    for (const p of c.registry.paneList) {
      const id = p.info.id;
      if (isCompanionPaneId(id)) continue;
      for (const pv of c.previews?.[id] ?? []) {
        const agent = c.names.get(id) ?? p.info.agent_type;
        const failed = (e: unknown) => c.notify(typeof e === 'string' ? e : 'Could not open the preview');
        out.push({
          id: `preview:${id}:${pv.port}`,
          group: 'Actions',
          title: `Open preview: ${agent} ${previewLabel(pv)}`,
          desc: pv.url,
          icon: <IconGlobe />,
          run: () => void pointApi.openPreview(id, pv.port).catch(failed),
        });
        out.push({
          id: `point:${id}:${pv.port}`,
          group: 'Actions',
          title: `Point and fix in the preview: ${agent} ${previewLabel(pv)}`,
          desc: 'Click the part that is wrong, then say what should change',
          keywords: 'point fix pick element change',
          icon: <IconGlobe />,
          run: () => void pointApi.openPreview(id, pv.port, true).catch(failed),
        });
      }
    }
    // Search the words inside the selected agent's project files (the right panel's Files section).
    if (c.selectedId && c.registry.panes.has(c.selectedId) && !isCompanionPaneId(c.selectedId)) {
      const paneId = c.selectedId;
      out.push({
        id: 'act:search-files',
        group: 'Actions',
        title: 'Search in files',
        desc: 'Find words inside the files of this project',
        keywords: 'search find text inside contents files code grep',
        icon: <IconSearch />,
        run: () => requestContentSearch(paneId),
      });
    }
    out.push({
      id: 'act:search-chats',
      group: 'Actions',
      title: SEARCH_CHATS_TITLE,
      desc: 'Find an answer from any agent, any day',
      keywords: 'find history conversation messages',
      icon: <IconSearch />,
      hint: bindingLabel('search-chats') || undefined,
      run: () => {
        setMode('chats');
        setQuery('');
      },
    });
    out.push({
      id: 'act:bring-chats',
      group: 'Actions',
      title: 'Bring my chats',
      desc: 'Pick an agent, then bring its recent chats here. Nothing leaves this PC.',
      keywords: 'import old previous chats history bring read other agents',
      icon: <IconNote />,
      run: requestBringChats,
    });
    // Live Room: Start while there is no room, Stop only while one runs. The toast after a stop comes from the cockpit.
    if (liveOn) {
      out.push({
        id: 'act:stop-live',
        group: 'Actions',
        title: 'Stop Live Room',
        desc: 'Ends the room now. The link stops working.',
        keywords: 'live room share stream stop end',
        icon: <IconStop />,
        run: () => void liveRoomApi.stop().catch((e: unknown) => c.notify(e instanceof Error ? e.message : 'Could not stop the Live Room')),
      });
    } else if (liveStatus !== undefined) {
      out.push({
        id: 'act:start-live',
        group: 'Actions',
        title: 'Start Live Room…',
        desc: 'Let people with a link watch a chat. Secrets and folders stay hidden.',
        keywords: 'live room share stream watch broadcast go live',
        icon: <IconGlobe />,
        run: () => requestGoLive(c.selectedId),
      });
    }
    // "Leaving my desk": hand the day to the phone, and "I'm back" while it is on. Only when a phone is paired.
    if (isAway(deskAway)) {
      out.push({
        id: 'act:desk-back',
        group: 'Actions',
        title: tr('desk.palette.back'),
        desc: tr('desk.away'),
        keywords: 'away back leaving desk phone return',
        icon: <IconMoon />,
        run: () => void deskStore.back().catch(() => undefined),
      });
    } else if (deskAway.phones > 0) {
      out.push({
        id: 'act:desk-away',
        group: 'Actions',
        title: tr('desk.title'),
        desc: tr('desk.palette.desc'),
        keywords: 'away leaving desk phone remote hand over lunch',
        icon: <IconMoon />,
        run: openDeskSheet,
      });
    }
    if (onStopAll) {
      out.push({
        id: 'act:stop-all',
        group: 'Actions',
        title: 'Stop all agents',
        desc: 'Stops every agent that is working. Their conversations stay open.',
        icon: <IconStop />,
        run: onStopAll,
      });
    }
    if (onOpenDoctor) {
      out.push({
        id: 'act:doctor',
        group: 'Actions',
        title: 'Set up agents',
        desc: 'Check which agents work and fix the ones that do not',
        icon: <IconTerminal />,
        run: onOpenDoctor,
      });
    }
    if (onOpenWelcome) {
      out.push({
        id: 'act:welcome',
        group: 'Actions',
        title: WELCOME.paletteTitle,
        desc: WELCOME.paletteDesc,
        icon: <IconNote />,
        run: onOpenWelcome,
      });
    }
    if (onStartCrew) {
      out.push({
        id: 'act:start-crew',
        group: 'Actions',
        title: 'Start crew…',
        desc: 'Start a saved team of agents in a folder',
        keywords: 'crew team helpers minions saved template',
        icon: <IconLayers />,
        run: onStartCrew,
      });
    }
    out.push({
      id: 'act:whatsnew',
      group: 'Actions',
      title: tr('whatsnew.menuWhatsNew'),
      desc: tr('whatsnew.paletteWhatsNewDesc'),
      keywords: 'whats new tour release notes changes update highlights',
      icon: <IconInfo />,
      run: () => openTour(),
    });
    out.push({
      id: 'act:guide',
      group: 'Actions',
      title: tr('whatsnew.menuGuide'),
      desc: tr('whatsnew.paletteGuideDesc'),
      keywords: 'feature guide features demo help learn what can it do',
      icon: <IconNote />,
      run: requestGuide,
    });
    if (onOpenShortcuts) {
      out.push({
        id: 'act:shortcuts',
        group: 'Actions',
        title: 'Keyboard shortcuts',
        desc: 'Every key that works in the app',
        keywords: 'keys keyboard hotkeys help shortcut',
        icon: <IconNote />,
        hint: '?',
        run: onOpenShortcuts,
      });
    }
    if (onOpenMemory) {
      out.push({
        id: 'act:memory',
        group: 'Actions',
        title: 'Project…',
        desc: 'Memory every agent reads, and how copies get ready',
        keywords: 'project memory copies setup',
        icon: <IconNote />,
        run: onOpenMemory,
      });
    }
    if (onOpenPlans) {
      out.push({
        id: 'act:plans',
        group: 'Actions',
        title: 'Your plans',
        desc: 'What each plan did this month: turns, time, files and limits',
        keywords: 'plans month usage limit subscription account turns time',
        icon: <IconChart />,
        run: onOpenPlans,
      });
    }
    if (onOpenScores) {
      out.push({
        id: 'act:scores',
        group: 'Actions',
        title: 'Scores on your code',
        desc: 'Which agent works best here, from your own history',
        keywords: 'scores best agent compare results history',
        icon: <IconChart />,
        run: onOpenScores,
      });
    }
    if (onOpenTeam) {
      out.push({
        id: 'act:team',
        group: 'Actions',
        title: t('teamHub.side'),
        desc: t('teamHub.palette.desc'),
        keywords: 'team people teammates usage tasks shelf feed lend invite',
        icon: <IconTeam />,
        run: onOpenTeam,
      });
    }
    if (onOpenReview) {
      out.push({
        id: 'act:review',
        group: 'Actions',
        title: 'Review Desk',
        desc: 'Finished work from your agents, riskiest first',
        keywords: 'review desk keep look check finished work changes merge throw away',
        icon: <IconChart />,
        run: onOpenReview,
      });
    }
    if (onReviewRiskiest) {
      out.push({
        id: 'act:review-riskiest',
        group: 'Actions',
        title: 'Review the riskiest item',
        desc: 'Open the Review Desk on the first item',
        keywords: 'review riskiest risk first high look check changes',
        icon: <IconChart />,
        run: onReviewRiskiest,
      });
    }
    if (onOpenStore) {
      out.push({
        id: 'act:store',
        group: 'Actions',
        title: 'Open Agent Store',
        desc: 'Find, install and add more agents',
        keywords: 'agent store more agents add install browse catalog',
        icon: <IconPlus />,
        run: onOpenStore,
      });
    }
    out.push(...settingsShortcuts(c, { missionsOn, nightOn, onOpenMorning, projectPath: c.selectedId ? (c.registry.panes.get(c.selectedId)?.info?.cwd ?? null) : null }));
    out.push(
      {
        id: 'act:settings',
        group: 'Actions',
        title: 'Open settings',
        icon: <IconSettings />,
        run: () => void c.openSettings(),
      },
      {
        id: 'act:toolbelt',
        group: 'Actions',
        title: 'Toolbelt…',
        desc: 'Connect other tools',
        keywords: 'mcp servers toolbelt tools plugins connect',
        icon: <IconLayers />,
        run: () => void c.openSettings('bridge'),
      },
      {
        id: 'act:mode',
        group: 'Actions',
        title: c.mode === 'orchestration' ? 'Switch to Individual mode' : 'Switch to Orchestration mode',
        desc: c.mode === 'orchestration' ? 'Every pane in its own window' : 'Every pane in this window',
        icon: <IconLayers />,
        run: () => void c.setMode(c.mode === 'orchestration' ? 'individual' : 'orchestration'),
      },
      {
        id: 'act:theme',
        group: 'Actions',
        title: isDarkTheme(c.theme) ? 'Switch to light theme' : 'Switch to dark theme',
        icon: isDarkTheme(c.theme) ? <IconSun /> : <IconMoon />,
        run: () => void c.toggleTheme(),
      },
    );
    // One row per id: a repeated id makes React keep stale copies of the row while you type.
    const seen = new Set<string>();
    return out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  }, [c, terminals, laneView, onOpenDoctor, onStopAll, onOpenMemory, onOpenPlans, onOpenScores, onOpenTeam, onOpenReview, onReviewRiskiest, onOpenStore, onUndoLastTurn, onWhatBroke, onOpenWelcome, onStartCrew, onOpenShortcuts, onOpenInbox, needsYou, openedStandbyPanes, keysVersion, missionsOn, nightOn, guideOn, onOpenMorning, companions, onOpenCompanion, onNewCompanion, liveStatus, liveOn, deskAway, deskStore, t]);

  const filtered = useMemo(
    () => items.filter((i) => matchesQuery(`${i.title} ${i.desc ?? ''} ${i.keywords ?? ''} ${i.group}`, query)),
    [items, query],
  );

  const count = mode === 'chats' ? chats.hits.length : filtered.length;
  useEffect(() => setIndex(0), [query, mode, filters]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, filtered, chats.hits]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    // "Search all chats" switches the palette over and keeps it open.
    if (item.id === 'act:search-chats') {
      item.run();
      return;
    }
    onClose();
    item.run();
  };

  // Opens the pane's Chat at the message; a pane that is gone shows what was kept.
  const chooseHit = (hit: ChatHit | undefined) => {
    if (!hit) return;
    // An old chat the person brought in has no pane: it opens read-only in its own sheet, at the message.
    if (hit.imported) {
      onClose();
      requestImportedChat(hit.agent, hit.session, hit.itemId);
      return;
    }
    if (!c.registry.panes.has(hit.paneId)) {
      setClosedHit(hit);
      return;
    }
    onClose();
    requestChatJump(hit.paneId, hit.itemId);
    c.select(hit.paneId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => (count ? (i + 1) % count : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (count ? (i - 1 + count) % count : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'chats') chooseHit(chats.hits[index]);
      else choose(filtered[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (closedHit) setClosedHit(null);
      else onClose();
    } else if (e.key === 'Backspace' && mode === 'chats' && !query) {
      // Nothing left to delete: back to the commands.
      e.preventDefault();
      setMode('commands');
    }
  };

  let lastGroup = '';
  return (
    <div className="ck-scrim ck-scrim--top" onMouseDown={onClose}>
      <div className="ck-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="ck-palette-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === 'chats' ? 'Search what was said · agent:, in:, from:' : 'Switch pane, start an agent, run an action'}
          aria-label={mode === 'chats' ? SEARCH_CHATS_TITLE : 'Search commands'}
          role="combobox"
          aria-expanded="true"
          aria-controls="ck-palette-list"
        />
        {mode === 'chats' && (
          <div className="ck-palette-mode">
            <span>{SEARCH_CHATS_TITLE}</span>
            <span className="ck-palette-mode-note">Chats you have opened</span>
          </div>
        )}
        {mode === 'chats' && !closedHit && (
          <ChatFilterChips filters={filters} facets={facets} agentName={(id) => agentLabel(listing, id)} onPick={pickChip} />
        )}
        {closedHit && (
          <ChatHitDetail hit={closedHit} agentName={agentLabel(listing, closedHit.agent)} now={Date.now()} onBack={() => setClosedHit(null)} />
        )}
        <div className="ck-palette-list" id="ck-palette-list" role="listbox" ref={listRef} hidden={!!closedHit}>
          {mode === 'chats' && (
            <>
              {chats.hits.length === 0 && (
                <p className="ck-sub ck-pad">
                  {!query.trim() && !hasChatFilters(filters)
                    ? 'Type to search every chat you have opened.'
                    : chats.state === 'searching'
                      ? 'Searching…'
                      : chats.state === 'failed'
                        ? 'Search is not available right now.'
                        : chats.state === 'off'
                          ? 'Search is off — turn it on in Settings'
                          : 'No matches'}
                </p>
              )}
              <ChatHitRows
                hits={chats.hits}
                index={index}
                agentName={(id) => agentLabel(listing, id)}
                onHover={setIndex}
                onChoose={chooseHit}
                now={Date.now()}
              />
            </>
          )}
          {mode === 'commands' && filtered.length === 0 && <p className="ck-sub ck-pad">No matches</p>}
          {mode === 'commands' && filtered.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="ck-caption">{header}</div>}
                <div
                  role="option"
                  aria-selected={i === index}
                  data-active={i === index}
                  className={`ck-palette-row${i === index ? ' is-active' : ''}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(item)}
                >
                  <span className="ck-palette-ic">{item.icon}</span>
                  <span className="ck-palette-title">{item.title}</span>
                  {item.desc && <span className="ck-palette-desc">{item.desc}</span>}
                  {item.hint && <kbd className="ck-chip-key ck-kbd">{item.hint}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
