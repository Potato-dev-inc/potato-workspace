// @vitest-environment jsdom
import { setHelpersInSidebar } from './lib/helpersInSidebar';
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CockpitApp from './CockpitApp';
import { startDrag } from './components/dnd/dragStore';
import { setStandbys } from './lib/helper-standbys';
import { resetSideWidth, setSideWidth } from './lib/panel-widths';
import { setFocusMode } from './lib/focus-mode';
import { requestGoLive, type LiveStatus } from './lib/live-room';
import { requestBringChats, requestImportedChat } from './lib/chatImport';
import { runStoreCheck } from './lib/agentStoreCheck';
import { tauriClosedChatsApi } from './lib/closedChats';
import { requestGettingStarted } from './lib/getting-started';
import { resetUndoBar, showUndo } from './lib/undo-bar';
import { reportProblem, resetProblems } from './lib/problems';
import { closeSignInAgain } from './lib/agentSignIn';
import { devicesApi } from './lib/devices';
import { onFocusDeviceGroup } from './lib/openDevice';
import { tauri } from './lib/tauri';
import { deskStore, setDeskSheetOpen, NOT_AWAY, type DeskAway } from './lib/desk-away';
import { MAC_MINI, NODE_MAC } from './dev/devices-fixtures';

// Mutable per-test input for the digest (away) path.
const away = vi.hoisted(() => ({ digest: null as null | object }));
// The real Inbox: on, the Inbox mock hands over to the real page, with these turn summaries and this clock.
const inb = vi.hoisted(() => ({ real: false, now: 0, turns: new Map() as Map<string, unknown>, names: new Map<string, string>(), notes: [] as string[] }));
// The spawn the (mocked) cockpit hook reports: null, running, or failed.
const ui = vi.hoisted(() => ({ spawn: null as null | { failed: string | null } }));
// The chat that is starting, as the (mocked) cockpit hook reports it: null when none.
const chatStart = vi.hoisted(() => ({ starting: null as null | { agentId: string; folder: string } }));
// The UI mode and the "open the Settings window" command (what Individual mode uses) the mocked cockpit reports.
const cockpit = vi.hoisted(() => ({
  mode: 'orchestration' as 'orchestration' | 'individual',
  openSettings: (async () => {}) as (tab?: string) => Promise<void>,
  // Every `newAgent(...)` call: a sign-in must never start an agent (a sidebar row or pane) in the main workspace.
  newAgents: [] as unknown[][],
  // The pane list is known (the split restores on start only then). Off by default, as before.
  ready: false,
  // More panes than p1 and p2 (the split grid needs up to four). None by default, so other tests see two.
  extraIds: [] as string[],
  // A helper's parent: { p2: 'p1' } makes p2 a helper of p1 (the helpers bar then shows it).
  parents: {} as Record<string, string>,
  // What a pane was started as ({ p2: 'minion' }); absent = a helper or the person's own chat.
  startedAs: {} as Record<string, string>,
  // Panes that are working or need you (status by id); the rest are idle.
  statuses: {} as Record<string, string>,
  // The first-switch sheet the (mocked) hook reports, and what Switch / Cancel did.
  explainer: { open: false, confirm: (async () => {}) as (d: boolean) => Promise<void>, cancel: () => {} },
}));
// The Live Room the (mocked) app reports, and the toasts the cockpit shows.
const live = vi.hoisted(() => ({
  status: { live: false, paused: false, viewers: 0, endsAtMs: 0, paneIds: [] as string[], hidden: 0, stopped: null as string | null },
  listeners: [] as Array<(s: unknown) => void>,
  notes: [] as string[],
  stops: 0,
}));
// The Bring my chats sheets: the pane start the (mocked) registry does.
const imp = vi.hoisted(() => ({ spawnPane: (async () => 'p2') as (a: unknown) => Promise<string> }));
// The runner the Store page was given (the mocked StoreHost records it).
const store = vi.hoisted(() => ({ runCheck: undefined as unknown }));
// Rust's "show Settings in this window" event (cockpit://settings).
const rust = vi.hoisted(() => ({
  openSettings: null as null | ((e: { tab?: string | null }) => void),
  openView: null as null | ((e: { view: string; bot?: string | null }) => void),
}));

// The companions the (mocked) list hook reports: null is no companion backend.
const comps = vi.hoisted(() => ({ list: null as null | object[] }));
// The desktop shell's event channel, for the OS-link tests below (it does nothing for every other test).
const shell = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: unknown }) => void>(), pending: null as unknown }));
vi.mock('@tauri-apps/api/event', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/event')>()),
  listen: async (name: string, fn: (e: { payload: unknown }) => void) => {
    shell.handlers.set(name, fn);
    return () => void shell.handlers.delete(name);
  },
}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: async (cmd: string) => {
    if (cmd !== 'take_pending_join_link') return new Promise(() => undefined); // other commands never answer
    const link = shell.pending;
    shell.pending = null;
    return link;
  },
}));

vi.mock('./hooks/useCompanions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hooks/useCompanions')>()),
  useCompanions: () => ({ companions: comps.list, refresh: () => {} }),
}));

// The Today page's Labs switch the (mocked) hook reports, and the page itself (its own tests are in components/timeline).
const today = vi.hoisted(() => ({ on: false }));
vi.mock('./lib/timeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/timeline')>()),
  useTimelineEnabled: () => today.on,
}));
vi.mock('./components/timeline/TodayPage', async () => {
  const { createElement: h } = await import('react');
  return {
    defaultAgentName: (type: string) => type,
    TodayPage: ({ onClose, panes }: { onClose: () => void; panes?: { id: string }[] }) =>
      h('div', null, `TODAY VIEW ${(panes ?? []).map((x) => x.id).join(',')}`, h('button', { type: 'button', onClick: onClose }, 'Close today')),
  };
});

// The devices state the (mocked) group hook reports: null is the Labs switch off.
const opened = vi.hoisted(() => ({ result: undefined as boolean | void }));
const dev = vi.hoisted(() => ({ view: null as null | { enabled: boolean; devices: unknown[] }, groups: [] as unknown[] }));
vi.mock('./components/devices/useDeviceGroups', () => ({
  useDeviceGroups: () => ({ view: dev.view, enabled: dev.view?.enabled === true, groups: dev.groups, questions: [], answerQuestion: async () => {}, hideQuestion: () => {}, refresh: () => {}, watch: () => {} }),
}));

vi.mock('./hooks/useCockpit', async () => {
  const { useState } = await import('react');
  return {
    useCockpit: () => {
      const [selectedId, setSelectedId] = useState<string | null>('p1');
      const ids = ['p1', 'p2', ...cockpit.extraIds];
      const infoOf = (id: string) => ({ id, cwd: `/proj/${id}`, agent_type: `agent-${id}`, parent_pane_id: cockpit.parents[id] ?? null, started_as: cockpit.startedAs[id] ?? null });
      return {
        selectedId,
        // Like the real hook: picking a pane keeps a running spawn and clears a failed one.
        select: (id: string | null) => {
          if (id && ui.spawn?.failed) ui.spawn = null;
          setSelectedId(id);
        },
        spawn: ui.spawn,
        dismissSpawn: () => {},
        chatStarting: chatStart.starting,
        beginChatStart: () => {},
        endChatStart: () => {},
        mode: cockpit.mode,
        setMode: async () => {},
        modeExplainer: cockpit.explainer,
        openSettings: cockpit.openSettings,
        newAgent: async (...a: unknown[]) => void cockpit.newAgents.push(a),
        notify: (text: string) => void (live.notes.push(text), inb.notes.push(text)),
        theme: 'dark',
        now: inb.now,
        toasts: [],
        names: inb.real ? inb.names : new Map<string, string>(),
        asked: { questions: [], answerQuestion: async () => {}, dismissQuestion: async () => {} },
        prompts: {},
        statusSince: new Map(),
        launchEntries: [],
        readyAgents: new Set<string>(),
        registry: {
          spawnPane: (a: unknown) => imp.spawnPane(a),
          paneList: ids.map((id) => ({ info: infoOf(id), status: cockpit.statuses[id] ?? 'idle' })),
          panes: new Map(ids.map((id) => [id, { info: infoOf(id), status: cockpit.statuses[id] ?? 'idle' }])),
          initialReady: cockpit.ready,
        },
      };
    },
  };
});

vi.mock('./lib/cockpit-api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./lib/cockpit-api')>();
  return {
    ...orig,
    cockpitApi: {
      ...orig.cockpitApi,
      onSettingsOpen: (cb: (e: { tab?: string | null }) => void) => {
        rust.openSettings = cb;
        return Promise.resolve(() => {});
      },
      onView: (cb: (e: { view: string; bot?: string | null }) => void) => {
        rust.openView = cb;
        return Promise.resolve(() => {});
      },
    },
  };
});

vi.mock('./lib/live-room', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./lib/live-room')>();
  return {
    ...orig,
    onLiveState: (cb: (s: unknown) => void) => {
      live.listeners.push(cb);
      return Promise.resolve(() => {
        live.listeners = live.listeners.filter((x) => x !== cb);
      });
    },
    liveRoomApi: {
      ...orig.liveRoomApi,
      status: async () => live.status,
      stop: async () => void (live.stops += 1),
      configGet: async () => ({ relay: 'https://relay.example.test', minutes: 60, maxViewers: 10 }),
      preview: async () => ({ panes: [], items: [], hidden: 0 }),
    },
  };
});

vi.mock('./hooks/useAway', () => ({
  useAway: () => ({ digest: away.digest, dismissDigest: () => {}, lastTurn: inb.real ? inb.turns : null }),
}));

// What the (mocked) Needs-you source reports; the Problems list follows it.
const needs = vi.hoisted(() => ({ items: [] as Array<{ id: string; kind: string; paneId?: string }> }));
// The quiet start-up check: on, with fake sources the test sets.
const startup = vi.hoisted(() => ({ health: [] as unknown[] }));
vi.mock('./hooks/useNeedsYou', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hooks/useNeedsYou')>()),
  useNeedsYouSource: () => needs.items,
}));
vi.mock('./lib/startup-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/startup-check')>()),
  canStartupCheck: () => true,
  tauriStartupDeps: () => ({
    agentHealth: async () => startup.health,
    bridgeUp: () => true,
    diskFreeBytes: async () => 100 * 1024 ** 3,
    updateReachable: async () => true,
    lanes: async () => null,
    settings: async () => null,
  }),
}));

vi.mock('./lib/loop-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/loop-guard')>()),
  useLoopSignals: () => ({ signals: {}, dismiss: () => {} }),
  tauriLoopApi: {
    onPanic: () => Promise.resolve(() => {}),
    stopAll: () => Promise.resolve({}),
  },
}));

vi.mock('./lib/desktop-nudge', () => ({ useNudgeOnAction: () => ({ onClickCapture: () => {} }) }));
vi.mock('./lib/agent-health', () => ({ markSpawned: () => {} }));
// The "Used" bar: one signed-in agent, and the setting on (the real bar renders from these).
vi.mock('./lib/usage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./lib/usage')>();
  const snap = {
    refreshed_at_ms: 0,
    rows: [{ agent_id: 'codex', label: 'Codex CLI', account_id: null, account_label: null, state: 'ok', reason: null, windows: [{ name: '5-hour', used_percent: 40, reset_since: false }], plan: null, observed_at_ms: null, limited_until_ms: null, page: null }],
  };
  return {
    ...orig,
    useUsageBarOn: () => ({ on: true, loginReads: true }),
    usageApi: { snapshot: async () => snap, openPage: async () => {}, onChanged: async () => () => {} },
  };
});

// Child views are stubbed so the test exercises only CockpitApp's view wiring.
vi.mock('./components/cockpit/Sidebar', async () => {
  const { createElement: h } = await import('react');
  type Props = {
    c: { select: (id: string | null) => void; openSettings: (tab?: string) => Promise<void>; registry: { paneList: { info: { id: string } }[] } };
    onOpenDoctor: () => void;
    onOpenMemory: () => void;
    onOpenScores: () => void;
    onOpenToday?: () => void;
    onOpenReview?: () => void;
    onOpenMorning?: () => void;
    onOpenRoutines?: () => void;
    onOpenConnect?: () => void;
    onOpenStore?: () => void;
    onOpenToSide?: (id: string) => void;
    onOpenPlaced?: (id: string, where: 'left' | 'down') => void;
    onOpenNewAgent?: () => void;
    newAgentOpen?: boolean;
    companions?: { id: string; name: string }[] | null;
    onOpenCompanion?: (id: string) => void;
    onNewCompanion?: () => void;
  };
  return {
    Sidebar: ({ c, onOpenDoctor, onOpenMemory, onOpenScores, onOpenToday, onOpenReview, onOpenMorning, onOpenRoutines, onOpenConnect, onOpenStore, onOpenToSide, onOpenPlaced, onOpenNewAgent, newAgentOpen, companions, onOpenCompanion, onNewCompanion }: Props) =>
      h(
        'div',
        null,

        h('button', { type: 'button', onClick: onOpenDoctor }, 'Set up agents'),
        h('button', { type: 'button', onClick: () => onOpenNewAgent?.(), 'aria-current': newAgentOpen ? 'page' : undefined }, 'New agent row'),
        h('button', { type: 'button', onClick: () => onOpenToSide?.('p2') }, 'Open p2 to the side'),
        h('button', { type: 'button', onClick: () => onOpenToSide?.('p3') }, 'Open p3 to the side'),
        h('button', { type: 'button', onClick: () => onOpenPlaced?.('p2', 'left') }, 'Open p2 on the left'),
        h('button', { type: 'button', onClick: () => onOpenPlaced?.('p3', 'down') }, 'Open p3 below'),
        h('button', { type: 'button', onClick: onOpenMemory }, 'Project memory'),
        h('button', { type: 'button', onClick: onOpenScores }, 'Scores'),
        ...(onOpenToday ? [h('button', { key: 'today', type: 'button', onClick: onOpenToday }, 'Today row')] : []),
        h('button', { type: 'button', onClick: onOpenReview }, 'Review'),
        h('button', { type: 'button', onClick: onOpenMorning }, 'Night Shift chip'),
        h('button', { type: 'button', onClick: onOpenRoutines }, 'Routines row'),
        h('button', { type: 'button', onClick: onOpenConnect }, 'Connect row'),
        h('button', { type: 'button', onClick: () => void c.openSettings('lend-page') }, 'Old lend link'),
        // The "More agents…" row of the "+" menu (its own wiring is tested in NewAgentMenu.test.tsx).
        h('button', { type: 'button', onClick: onOpenStore }, 'More agents…'),
        h('button', { type: 'button', onClick: () => void c.openSettings() }, 'Settings'),
        h('button', { type: 'button', onClick: () => c.select(null) }, 'Inbox'),
        ...c.registry.paneList.map((p) =>
          h('button', { key: p.info.id, type: 'button', onClick: () => c.select(p.info.id) }, `pane ${p.info.id}`),
        ),
        ...(companions ?? []).map((x) => h('button', { key: x.id, type: 'button', onClick: () => onOpenCompanion?.(x.id) }, `companion ${x.name}`)),
        h('button', { type: 'button', onClick: () => onNewCompanion?.() }, 'New companion row'),
      ),
  };
});
vi.mock('./components/cockpit/newagent/NewAgentHost', async () => {
  const { createElement: h } = await import('react');
  return { NewAgentHost: ({ onSetUp, project }: { onSetUp?: () => void; project?: { name: string } | null }) => h('div', null, 'NEW AGENT PAGE', project ? ` project:${project.name}` : '', h('button', { type: 'button', onClick: onSetUp }, 'Page set up')) };
});
vi.mock('./components/cockpit/AgentDoctor', async () => {
  const { createElement: h, Fragment } = await import('react');
  // The link sits beside the view (not inside it), so the view's own text stays 'DOCTOR VIEW'.
  return {
    AgentDoctor: ({ onOpenStore }: { onOpenStore?: () => void }) =>
      h(Fragment, null, h('div', null, 'DOCTOR VIEW'), h('button', { type: 'button', onClick: onOpenStore }, 'Doctor browse')),
  };
});
vi.mock('./components/cockpit/ProjectMemory', async () => {
  const { createElement: h } = await import('react');
  return { ProjectMemory: () => h('div', null, 'MEMORY VIEW') };
});
vi.mock('./components/cockpit/routines/RoutinesPage', async () => {
  const { createElement: h } = await import('react');
  return { RoutinesPage: ({ onClose }: { onClose: () => void }) => h('div', null, 'ROUTINES VIEW', h('button', { type: 'button', onClick: onClose }, 'Close routines')) };
});
vi.mock('./components/connect/ConnectPage', async () => {
  const { createElement: h } = await import('react');
  return {
    ConnectPage: ({ tab, onOpenPc, onOpenPane }: { tab: string; onOpenPc?: (node: string) => boolean | void; onOpenPane?: (id: string) => void }) =>
      h('div', null, `CONNECT VIEW ${tab}`, h('button', { type: 'button', onClick: () => (opened.result = onOpenPc?.('n1')) }, 'Open PC n1'), h('button', { type: 'button', onClick: () => onOpenPane?.('p2') }, 'Open SSH pane')),
  };
});
vi.mock('./components/cockpit/night/MorningPage', async () => {
  const { createElement: h } = await import('react');
  type Props = { onClose: () => void; onOpenPane?: (id: string) => void };
  return {
    MorningPage: ({ onClose, onOpenPane }: Props) =>
      h(
        'div',
        null,
        'MORNING VIEW',
        h('button', { type: 'button', onClick: onClose }, 'Close morning'),
        h('button', { type: 'button', onClick: () => onOpenPane?.('p2') }, 'Open task pane'),
      ),
  };
});
vi.mock('./components/cockpit/AgentScores', async () => {
  const { createElement: h } = await import('react');
  return { AgentScores: ({ project }: { project?: { path: string } | null }) => h('div', null, 'SCORES VIEW ' + (project?.path ?? 'all')) };
});
// The Review Desk is stubbed: its own behavior is tested in review/ReviewDesk.test.tsx. Here: the wiring only.
vi.mock('./components/cockpit/review/ReviewDesk', async () => {
  const { createElement: h } = await import('react');
  type Props = { openFirst?: boolean; onClose: () => void; onOpenPane: (id: string) => void; renderDetail?: unknown };
  return {
    ReviewDesk: ({ openFirst, onClose, onOpenPane, renderDetail }: Props) =>
      h(
        'div',
        null,
        'REVIEW VIEW first=' + String(Boolean(openFirst)) + ' detail=' + String(typeof renderDetail === 'function'),
        h('button', { type: 'button', onClick: onClose }, 'Close review'),
        h('button', { type: 'button', onClick: () => onOpenPane('p2') }, 'Review open pane'),
      ),
  };
});
vi.mock('./components/cockpit/review/ReviewDetail', async () => {
  const { createElement: h } = await import('react');
  return { ReviewDetail: () => h('div', null, 'REVIEW DETAIL') };
});
vi.mock('./components/store/StoreHost', async () => {
  const { createElement: h } = await import('react');
  type Props = { onBack: () => void; onOpenAgent: (id: string) => void; runCheck?: unknown };
  return {
    StoreHost: ({ onBack, onOpenAgent, runCheck }: Props) => {
      store.runCheck = runCheck;
      return h('div', null, 'STORE VIEW', h('button', { type: 'button', onClick: onBack }, 'Store back'), h('button', { type: 'button', onClick: () => onOpenAgent('qwen') }, 'Store open qwen'));
    },
  };
});
// The split view's own rendering is tested in SplitView.test.tsx; here only its wiring from CockpitApp.
vi.mock('./components/cockpit/SplitView', async () => {
  const { createElement: h, useEffect, useState } = await import('react');
  type Below = { leftDown: string | null; rightDown: string | null; leftRows: number; rightRows: number; wide?: boolean; stacked?: boolean };
  type Props = { leftId: string; rightId: string; focus: string; ratio: number; below?: Below; onClose: () => void; onFocus: (side: string) => void; onRatio: (r: number) => void; onCloseChat?: (slot: string) => void; onSplitDown?: (column: string) => void };
  return {
    useWindowWidth: () => {
      const [w, setW] = useState(() => window.innerWidth);
      useEffect(() => {
        const on = () => setW(window.innerWidth);
        window.addEventListener('resize', on);
        return () => window.removeEventListener('resize', on);
      }, []);
      return w;
    },
    SplitView: ({ leftId, rightId, focus, ratio, below, onClose, onFocus, onRatio, onCloseChat, onSplitDown }: Props) =>
      h(
        'div',
        null,
        `SPLIT VIEW ${leftId}|${rightId}|${focus}|${ratio}${below && (below.leftDown || below.rightDown) ? `|down:${below.leftDown ?? '-'},${below.rightDown ?? '-'}` : ''}${below?.stacked ? '|stacked' : ''}${below?.wide ? '|wide' : ''}`,
        h('button', { type: 'button', onClick: () => onRatio(0.58) }, 'Set divider 58'),
        h('button', { type: 'button', onClick: () => onFocus('left') }, 'Focus left'),
        h('button', { type: 'button', onClick: onClose }, 'Close split'),
        h('button', { type: 'button', onClick: () => onSplitDown?.('left') }, 'Split down left'),
        h('button', { type: 'button', onClick: () => onCloseChat?.(focus) }, 'Close focused chat'),
        h('button', { type: 'button', onClick: () => onFocus('right') }, 'Focus right'),
      ),
    focusSideComposer: () => {},
  };
});
vi.mock('./components/cockpit/PaneView', async () => {
  const { createElement: h } = await import('react');
  return {
    PaneView: ({ paneId, onSeeDay }: { paneId: string; onSeeDay?: () => void }) =>
      h('div', null, `PANE VIEW ${paneId}`, onSeeDay ? h('button', { type: 'button', onClick: onSeeDay }, 'See the whole day') : null),
  };
});
vi.mock('./components/cockpit/Inbox', async () => {
  const { createElement: h } = await import('react');
  const real = await vi.importActual<typeof import('./components/cockpit/Inbox')>('./components/cockpit/Inbox');
  type Props = { c: { openSettings: (tab?: string) => Promise<void> } };
  return {
    Inbox: (p: Props & Record<string, unknown>) =>
      inb.real ? h(real.Inbox as never, p) : h(
        'div', null, 'INBOX VIEW', h('button', { type: 'button', onClick: () => void p.c.openSettings('preload') }, 'Inbox deep link')),
  };
});
let settingsMounts = 0;
vi.mock('./components/cockpit/SettingsView', async () => {
  const { createElement: h, useEffect } = await import('react');
  type Props = { initialTab?: string; onBack: () => void; onPageChange?: (page: string) => void; onOpenStore?: () => void };
  return {
    SettingsView: ({ initialTab, onBack, onPageChange, onOpenStore }: Props) => {
      useEffect(() => {
        settingsMounts += 1;
        onPageChange?.(initialTab ?? 'agents');
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return h(
        'div',
        null,
        'SETTINGS VIEW tab=' + initialTab + ';',
        h('button', { type: 'button', onClick: onBack }, 'Settings back'),
        h('button', { type: 'button', onClick: () => onPageChange?.('keys') }, 'Go to Keys'),
        h('button', { type: 'button', onClick: onOpenStore }, 'Settings browse'),
      );
    },
  };
});
vi.mock('./components/cockpit/AwayDigest', async () => {
  const { createElement: h } = await import('react');
  return {
    AwayDigest: ({ onOpenPane }: { onOpenPane: (id: string) => void }) =>
      h('button', { type: 'button', onClick: () => onOpenPane('p2') }, 'Open digest pane'),
  };
});
vi.mock('./components/cockpit/SpawnView', async () => {
  const { createElement: h } = await import('react');
  return { SpawnView: () => h('div', null, 'SPAWN VIEW') };
});
vi.mock('./components/cockpit/ChatStartingView', async () => {
  const { createElement: h } = await import('react');
  return { ChatStartingView: () => h('div', { role: 'status' }, 'CHAT STARTING VIEW') };
});
vi.mock('./components/cockpit/Palette', async () => {
  const { createElement: h } = await import('react');
  return {
    Palette: ({ initialMode, onOpenStore, onOpenReview, onReviewRiskiest }: { initialMode?: string; onOpenStore?: () => void; onOpenReview?: () => void; onReviewRiskiest?: () => void }) =>
      h(
        'div',
        { 'data-testid': 'palette', 'data-mode': initialMode },
        h('button', { type: 'button', onClick: onOpenStore }, 'Open Agent Store'),
        h('button', { type: 'button', onClick: onOpenReview }, 'Palette: Review Desk'),
        h('button', { type: 'button', onClick: onReviewRiskiest }, 'Palette: Review the riskiest item'),
      ),
  };
});
// The old chat sheet is stubbed: this test is about the host in the cockpit, not the sheet.
vi.mock('./components/history/ImportedChatSheet', async () => {
  const { createElement: h } = await import('react');
  type Props = { request: { agent: string; session: string }; onContinue: (p: unknown) => void; onClose: () => void };
  return {
    ImportedChatSheet: ({ request, onContinue, onClose }: Props) =>
      h('div', { role: 'dialog' }, `OLD CHAT ${request.agent}/${request.session}`,
        h('button', { type: 'button', onClick: () => onContinue({ ok: true, agentType: 'codex', cwd: 'C:/Users/you/shop', extraArgs: ['resume', 'sess-0001-abcd'] }) }, 'Continue here'),
        h('button', { type: 'button', onClick: onClose }, 'Close old chat')),
  };
});
vi.mock('./components/history/BringChatsPanel', async () => {
  const { createElement: h } = await import('react');
  return { BRING_CHATS_TITLE_ID: 'bc-panel-title', BringChatsPanel: ({ onClose }: { onClose?: () => void }) => h('p', null, 'BRING PANEL', h('button', { type: 'button', onClick: onClose }, 'Close bring')) };
});
vi.mock('./components/cockpit/UndoSheet', () => ({ UndoSheet: () => null }));
vi.mock('./components/cockpit/PanicSheet', () => ({ PanicSheet: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  today.on = false;
  away.digest = null;
  dev.view = null;
  dev.groups = [];
  opened.result = undefined;
  comps.list = null;
  ui.spawn = null;
  chatStart.starting = null;
  cockpit.mode = 'orchestration';
  cockpit.openSettings = vi.fn(async () => {});
  cockpit.newAgents = [];
  cockpit.ready = false;
  cockpit.parents = {};
  cockpit.startedAs = {};
  cockpit.statuses = {};
  live.status = { live: false, paused: false, viewers: 0, endsAtMs: 0, paneIds: [], hidden: 0, stopped: null };
  live.listeners = [];
  live.notes = [];
  live.stops = 0;
  localStorage.clear();
  inb.real = false;
  inb.now = 0;
  inb.turns = new Map();
  inb.names = new Map();
  inb.notes = [];
  needs.items = [];
  startup.health = [];
  resetProblems();
  rust.openSettings = null;
  rust.openView = null;
  settingsMounts = 0;
  window.history.replaceState(null, '', '/');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // Async, so the Live Room status read at mount settles inside the act.
  await act(async () => root.render(createElement(CockpitApp)));
});
afterEach(() => {
  resetUndoBar();
  act(() => root.unmount());
  host.remove();
});

function clickButton(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!button) throw new Error(`no button "${text}"`);
  act(() => button.click());
}
// The main view is the first child of <main>; the away digest, when shown, comes after it.
// The work area is 1000 x 600 (the middle line is 452-548; below y = 408 is the bottom zone).
const workAreaRect = () =>
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const w = this.getAttribute('data-testid') === 'work-drop';
    return { left: 0, right: w ? 1000 : 0, top: 0, bottom: w ? 600 : 0, width: w ? 1000 : 0, height: w ? 600 : 0, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
const mainText = () => host.querySelector('main')?.firstElementChild?.textContent;

describe('CockpitApp: the Used bar', () => {
  it('runs along the bottom of the cockpit root, outside the sidebar and the main area', async () => {
    await act(async () => {});
    const bar = host.querySelector('.cockpit > .ck-statusbar');
    expect(bar).not.toBeNull();
    expect(bar!.closest('main')).toBeNull();
    expect(bar!.closest('.ck-side')).toBeNull();
    expect(bar!.textContent).toContain('40%');
  });
});

describe('CockpitApp: the Problems chip', () => {
  const chip = () => host.querySelector('.cockpit > .ck-statusbar [data-testid="problems-chip"]');
  it('is not there while nothing failed', async () => {
    await act(async () => {});
    expect(chip()).toBeNull();
  });

  it('sits in the status bar with the number of open problems, opens the list, and the way out opens the chat', async () => {
    await act(async () => reportProblem({ id: 'error:p1', what: 'Agent stopped because of an error.', agent: 'Agent', agentId: 'agent-p1', paneId: 'p2', way: 'open_chat' }));
    expect(chip()!.textContent).toBe('1 problem');
    await act(async () => (chip() as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="problems-sheet"]')!.textContent).toContain('Agent stopped because of an error.');
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.pb-row button')].find((b) => b.textContent === 'Open the chat')!.click());
    expect(host.querySelector('[data-testid="problems-sheet"]')).toBeNull();
  });

  it('Sign in (an expired sign-in) opens the small sign-in sheet over the cockpit and starts no agent, no pane, no sidebar row', async () => {
    await act(async () => reportProblem({ id: 'signin:claude:', what: 'The Claude sign-in has expired.', agent: 'Claude', agentId: 'claude', paneId: null, way: 'sign_in' }));
    await act(async () => (chip() as HTMLButtonElement).click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.pb-row button')].find((b) => b.textContent === 'Sign in')!.click());
    const sheet = host.querySelector('[data-testid="signin-again-sheet"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.closest('.lend-sheet')).not.toBeNull();
    expect(sheet!.textContent).toContain('Sign in to Claude');
    expect(cockpit.newAgents).toEqual([]);
    await act(async () => closeSignInAgain());
    expect(host.querySelector('[data-testid="signin-again-sheet"]')).toBeNull();
  });

  it('follows the Needs-you list: an agent that stopped with an error becomes a problem, and is fixed when it is not stopped any more', async () => {
    needs.items = [{ id: 'error:p1', kind: 'error', paneId: 'p1' }];
    await act(async () => root.render(createElement(CockpitApp)));
    expect(chip()?.textContent).toBe('1 problem');
    needs.items = [];
    await act(async () => root.render(createElement(CockpitApp, { key: 'again' })));
    expect(chip()).toBeNull();
  });
});

describe('CockpitApp: the quiet start-up check', () => {
  it('shows nothing when all is fine, and one line with Sign in after the delay when an agent is signed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => root.unmount());
      root = createRoot(host);
      startup.health = [{ id: 'codex', label: 'Codex', state: 'needs_login', installed: true, version: '1', reason: '', install_hint: null, login_hint: null, can_test: true }];
      await act(async () => root.render(createElement(CockpitApp)));
      expect(host.querySelector('[data-testid="startup-check"]')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      expect(host.querySelector('[data-testid="startup-check"]')!.textContent).toContain('Codex needs sign-in');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CockpitApp: the undo bar', () => {
  it('is mounted: a bar shown from anywhere appears, and Undo runs its action', async () => {
    const undo = vi.fn();
    await act(async () => void showUndo({ text: 'Closed Billing tests', undo }));
    const bar = host.querySelector('[data-testid="undo-bar"]');
    expect(bar?.textContent).toContain('Closed Billing tests');
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-undobar-btn')!.click());
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Shift+T reopens the last closed chat and opens its pane', async () => {
    const api = tauriClosedChatsApi as { list: () => Promise<unknown>; reopen: (id: string) => Promise<string> };
    const list = vi.spyOn(api, 'list').mockResolvedValue([{ id: 'p2', agent: 'claude', label: 'Claude', cwd: '/x', updated_ms: 5, title: 'Old chat' }]);
    const reopen = vi.spyOn(api, 'reopen').mockResolvedValue('p2');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(list).toHaveBeenCalled();
    expect(reopen).toHaveBeenCalledWith('p2');
    list.mockRestore();
    reopen.mockRestore();
  });
});

describe('CockpitApp: the Getting started buttons', () => {
  it('"Open Review" opens the Review Desk', () => {
    act(() => requestGettingStarted('review'));
    expect(mainText()).toContain('REVIEW VIEW first=false');
  });

  it('"Show me" puts two agents side by side', () => {
    act(() => requestGettingStarted('side'));
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left');
  });

  it('"Open commands" opens the palette', () => {
    expect(host.querySelector('[data-testid="palette"]')).toBeNull();
    act(() => requestGettingStarted('undo'));
    expect(host.querySelector('[data-testid="palette"]')).not.toBeNull();
  });
});

describe('CockpitApp main view precedence', () => {
  it('shows the selected pane by default', () => {
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('(1) Project memory replaces the open Set up agents view', () => {
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
  });

  it('Morning: the Night Shift chip opens the page over the pane; Close and a task pane both leave it', () => {
    clickButton('Night Shift chip');
    expect(mainText()).toContain('MORNING VIEW');
    clickButton('Close morning');
    expect(mainText()).toBe('PANE VIEW p1');
    clickButton('Night Shift chip');
    clickButton('Open task pane');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Routines: the sidebar row opens the page over the pane and Close returns to it', () => {
    clickButton('Routines row');
    expect(mainText()).toContain('ROUTINES VIEW');
    clickButton('Close routines');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('Connect: the sidebar row opens the page over the pane and the next pane click leaves it', () => {
    clickButton('Connect row');
    expect(mainText()).toBe('CONNECT VIEW devicesOpen PC n1Open SSH pane');
    // Layout guard: the page sits in a scroll container (jsdom has no layout, so read the rule the wrapper uses).
    const wrap = host.querySelector('main [data-testid="connect-scroll"]');
    expect(wrap?.className).toBe('ck-connect-scroll');
    const css = readFileSync('src/styles/connect.css', 'utf8');
    const rule = css.slice(css.indexOf(".cockpit .ck-connect-scroll {"), css.indexOf("}", css.indexOf(".cockpit .ck-connect-scroll {")));
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("min-height: 0");
    expect(rule).toContain("flex: 1");
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Connect: a terminal opened on an SSH computer leaves the Connect page and shows that pane', () => {
    clickButton('Connect row');
    expect(mainText()).toContain('CONNECT VIEW');
    clickButton('Open SSH pane');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Connect: Open on a PC that has a sidebar section asks the sidebar to unfold and scroll to it; a PC with none answers false', async () => {
    const heard: string[] = [];
    const off = onFocusDeviceGroup((n) => heard.push(n));
    clickButton('Connect row');
    // No section yet: the page is told false (so it shows that PC's own sheet) and the sidebar is not asked.
    clickButton('Open PC n1');
    expect(opened.result).toBe(false);
    expect(heard).toEqual([]);
    dev.groups = [{ device: { node: 'n1', name: 'Mac', state: 'online' }, rows: [] }];
    await act(async () => root.render(createElement(CockpitApp)));
    clickButton('Open PC n1');
    // The section is unfolded AND the PC's own sheet opens (false), so Open never shows nothing.
    expect(opened.result).toBe(false);
    expect(heard).toEqual(['n1']);
    off();
  });

  it('Connect: an old Settings link for Lend opens the Lending tab, not Settings', () => {
    clickButton('Old lend link');
    expect(mainText()).toBe('CONNECT VIEW lendingOpen PC n1Open SSH pane');
    expect(cockpit.openSettings).not.toHaveBeenCalled();
  });

  it('Morning: the last click wins over Project memory', () => {
    clickButton('Project memory');
    clickButton('Night Shift chip');
    expect(mainText()).toContain('MORNING VIEW');
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
  });

  it('(2) clicking the already-selected pane leaves the Project memory view', () => {
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
    clickButton('pane p1');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('(3) clicking a pane leaves the Set up agents view', () => {
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('(4) a pane opened from the away digest leaves the Set up agents view', () => {
    away.digest = {};
    act(() => root.render(createElement(CockpitApp)));
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('Open digest pane');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  // The live bug "last click wins": whatever the person clicked last is what the main area shows.
  it('(5) the last click wins across every view', () => {
    clickButton('Project memory');
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
    clickButton('Inbox');
    expect(mainText()).toContain('INBOX VIEW');
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
    clickButton('Inbox');
    expect(mainText()).toContain('INBOX VIEW');
    clickButton('pane p1');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('(6) an agent that is starting shows its spawn view; Set up agents and Project memory cover it', () => {
    ui.spawn = { failed: null };
    act(() => root.render(createElement(CockpitApp)));
    expect(mainText()).toBe('SPAWN VIEW');
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
  });

  it('(7) picking a pane keeps a running spawn in front, but a failed spawn gives way to the pane', () => {
    ui.spawn = { failed: null };
    act(() => root.render(createElement(CockpitApp)));
    clickButton('pane p2');
    expect(mainText()).toBe('SPAWN VIEW');

    ui.spawn = { failed: 'could not start' };
    act(() => root.render(createElement(CockpitApp)));
    clickButton('pane p1');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  // Integration (r10): Settings is one more value of the same view state.
  it('(8) Settings covers a starting agent, and Back returns to its spawn view', () => {
    ui.spawn = { failed: null };
    act(() => root.render(createElement(CockpitApp)));
    expect(mainText()).toBe('SPAWN VIEW');
    clickButton('Settings');
    expect(mainText()).toContain('SETTINGS VIEW');
    clickButton('Settings back');
    expect(mainText()).toBe('SPAWN VIEW');
  });
});

describe('CockpitApp chat starting skeleton', () => {
  it('covers the open pane while a chat starts, and gives the pane back when it is done or failed', () => {
    const before = mainText();
    chatStart.starting = { agentId: 'codex', folder: 'C:\\work\\shop' };
    act(() => root.render(createElement(CockpitApp)));
    expect(host.querySelector('main [role="status"]')?.textContent).toBe('CHAT STARTING VIEW');
    expect(mainText()).toBe('CHAT STARTING VIEW');
    chatStart.starting = null;
    act(() => root.render(createElement(CockpitApp)));
    expect(host.querySelector('main [role="status"]')).toBeNull();
    expect(mainText()).toBe(before);
  });

  it('is in front of a running terminal spawn, because it is the chat the person just started', () => {
    ui.spawn = { failed: null };
    chatStart.starting = { agentId: 'codex', folder: 'C:\\work\\shop' };
    act(() => root.render(createElement(CockpitApp)));
    expect(mainText()).toBe('CHAT STARTING VIEW');
  });
});

describe('CockpitApp Review Desk wiring', () => {
  it('the sidebar button opens the desk over the pane; Close returns to the pane', () => {
    clickButton('Review');
    expect(mainText()).toContain('REVIEW VIEW first=false');
    clickButton('Close review');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('gives the desk a detail renderer', () => {
    clickButton('Review');
    expect(mainText()).toContain('detail=true');
  });

  it('opening an agent from the desk shows that pane', () => {
    clickButton('Review');
    clickButton('Review open pane');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('the palette opens the desk, and "Review the riskiest item" opens it on the first row', () => {
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })));
    clickButton('Palette: Review Desk');
    expect(mainText()).toContain('REVIEW VIEW first=false');
    clickButton('pane p1');
    clickButton('Palette: Review the riskiest item');
    expect(mainText()).toContain('REVIEW VIEW first=true');
  });

  it('the last click wins: the desk replaces Set up agents, and the inbox leaves the desk', () => {
    clickButton('Set up agents');
    clickButton('Review');
    expect(mainText()).toContain('REVIEW VIEW');
    clickButton('Inbox');
    expect(mainText()).toContain('INBOX VIEW');
    expect(mainText()).not.toContain('REVIEW VIEW');
  });
});

describe('CockpitApp Agent Store wiring', () => {
  it('"More agents…" in the "+" menu opens the store over the pane, and Back returns to the pane', () => {
    clickButton('More agents…');
    expect(mainText()).toContain('STORE VIEW');
    clickButton('Store back');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('the palette command "Open Agent Store" opens it', () => {
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })));
    clickButton('Open Agent Store');
    expect(mainText()).toContain('STORE VIEW');
  });

  it('Set up agents and Settings > Agents can open it, and Back returns to the resting view', () => {
    clickButton('Set up agents');
    clickButton('Doctor browse');
    expect(mainText()).toContain('STORE VIEW');
    clickButton('Store back');
    expect(mainText()).toBe('PANE VIEW p1');
    clickButton('Settings');
    clickButton('Settings browse');
    expect(mainText()).toContain('STORE VIEW');
    clickButton('Store back');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('Back returns to a starting agent when one is on screen', () => {
    ui.spawn = { failed: null };
    act(() => root.render(createElement(CockpitApp)));
    clickButton('More agents…');
    expect(mainText()).toContain('STORE VIEW');
    clickButton('Store back');
    expect(mainText()).toBe('SPAWN VIEW');
  });

  it('picking a pane, or the inbox, leaves the store', () => {
    clickButton('More agents…');
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
    clickButton('More agents…');
    clickButton('Inbox');
    expect(mainText()).toContain('INBOX VIEW');
  });

  it('the Store page gets the real "Check it works" runner', () => {
    clickButton('More agents…');
    expect(store.runCheck).toBe(runStoreCheck);
  });

  it('Individual mode never shows the store', () => {
    cockpit.mode = 'individual';
    act(() => root.render(createElement(CockpitApp)));
    clickButton('More agents…');
    expect(mainText()).toContain('Individual mode');
  });
});

describe('Settings in the cockpit', () => {
  const rerender = () => act(() => root.render(createElement(CockpitApp)));
  const openSettingsMock = () => cockpit.openSettings as unknown as ReturnType<typeof vi.fn>;
  const settingsTab = () => /SETTINGS VIEW tab=([a-z]+);/.exec(mainText() ?? '')?.[1];
  const fromRust = (e: { tab?: string }) => act(() => (rust.openSettings as (e: { tab?: string }) => void)(e));

  it('Orchestration: Settings opens inside the main area and the sidebar stays', () => {
    clickButton('Settings');
    expect(mainText()).toContain('SETTINGS VIEW');
    expect(host.querySelector('button')?.textContent).toBe('Set up agents'); // the sidebar is still there
    expect(openSettingsMock()).not.toHaveBeenCalled(); // no separate window
  });

  it('Individual: Settings is the separate window, never an inline view', () => {
    cockpit.mode = 'individual';
    rerender();
    clickButton('Settings');
    expect(openSettingsMock()).toHaveBeenCalledTimes(1);
    expect(openSettingsMock()).toHaveBeenCalledWith(undefined);
    expect(mainText()).not.toContain('SETTINGS VIEW');
  });

  it('a deep link opens the inline view on that section', () => {
    clickButton('pane p1');
    fromRust({ tab: 'bridge' });
    expect(settingsTab()).toBe('advanced');
  });

  it('a deep link from an Inbox card opens Settings on Agents (the old "preload" id means Agents)', () => {
    clickButton('Inbox');
    expect(mainText()).toContain('INBOX VIEW');
    clickButton('Inbox deep link');
    expect(settingsTab()).toBe('agents');
    clickButton('Settings back');
    expect(mainText()).toContain('INBOX VIEW');
  });

  it('a deep link while Settings is already open moves to that section; a plain open keeps the page', () => {
    clickButton('Settings');
    expect(settingsMounts).toBe(1);
    fromRust({ tab: 'keys' });
    expect(settingsTab()).toBe('keys');
    expect(settingsMounts).toBe(2);
    clickButton('Settings'); // same view, no tab: nothing reloads
    expect(settingsMounts).toBe(2);
    expect(settingsTab()).toBe('keys');
  });

  it('Back returns to the view that was showing before', () => {
    clickButton('Set up agents');
    clickButton('Settings');
    expect(mainText()).toContain('SETTINGS VIEW');
    clickButton('Settings back');
    expect(mainText()).toBe('DOCTOR VIEW');
  });

  it('Back from the default view returns to the selected pane', () => {
    clickButton('Settings');
    clickButton('Settings back');
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('(8) Scores replaces the open view, for the project of the selected pane', () => {
    clickButton('Set up agents');
    clickButton('Scores');
    expect(mainText()).toBe('SCORES VIEW /proj/p1');
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('the Today page opens from the sidebar and from a chat History link, only with the Labs switch on', () => {
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Today row')).toBe(false);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'See the whole day')).toBe(false);
  });

  it('with the Labs switch on, the Today row opens the page with the live chats, and a chat replaces it', () => {
    today.on = true;
    act(() => root.render(createElement(CockpitApp)));
    clickButton('Today row');
    expect(mainText()).toBe('TODAY VIEW p1,p2Close today');
    clickButton('pane p2');
    expect(mainText()).toContain('PANE VIEW p2');
    clickButton('Today row');
    clickButton('Close today');
    expect(mainText()).toContain('PANE VIEW p2');
  });

  it('with the Labs switch on, the History tab link opens the page', () => {
    today.on = true;
    act(() => root.render(createElement(CockpitApp)));
    clickButton('See the whole day');
    expect(mainText()).toBe('TODAY VIEW p1,p2Close today');
  });

  it('the last click wins: a pane, Project memory or Set up agents replaces Settings, and Settings replaces them', () => {
    clickButton('Settings');
    clickButton('pane p2');
    expect(mainText()).toBe('PANE VIEW p2');
    clickButton('Settings');
    clickButton('Project memory');
    expect(mainText()).toBe('MEMORY VIEW');
    clickButton('Settings');
    expect(mainText()).toContain('SETTINGS VIEW');
    clickButton('Set up agents');
    expect(mainText()).toBe('DOCTOR VIEW');
  });

  it('switching to Individual with Settings open moves it to the Settings window, on the same page', () => {
    clickButton('Settings');
    clickButton('Go to Keys');
    cockpit.mode = 'individual';
    rerender();
    expect(openSettingsMock()).toHaveBeenCalledTimes(1);
    expect(openSettingsMock()).toHaveBeenCalledWith('keys');
    // Back in Orchestration the cockpit is not stuck on a stale Settings view (the window has it now).
    cockpit.mode = 'orchestration';
    rerender();
    expect(mainText()).toBe('PANE VIEW p1');
    expect(host.textContent).not.toContain('SETTINGS VIEW');
  });

  it('switching to Individual with Settings closed opens no Settings window', () => {
    cockpit.mode = 'individual';
    rerender();
    expect(openSettingsMock()).not.toHaveBeenCalled();
  });

  it('a cockpit window created for Settings (?view=settings&tab=) opens on it, after the view resets', async () => {
    act(() => root.unmount());
    window.history.replaceState(null, '', '/?cockpit=1&view=settings&tab=bridge');
    root = createRoot(host);
    await act(async () => root.render(createElement(CockpitApp)));
    // Effects flush when act ends; the link opens on the next tick.
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(settingsTab()).toBe('advanced');
  });
});

describe('CockpitApp palette shortcuts', () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  const palette = () => host.querySelector<HTMLElement>('[data-testid="palette"]');

  it('Ctrl+K opens the commands and a second Ctrl+K closes them', () => {
    expect(palette()).toBeNull();
    press({ key: 'k', ctrlKey: true });
    expect(palette()?.dataset.mode).toBe('commands');
    press({ key: 'k', ctrlKey: true });
    expect(palette()).toBeNull();
  });

  it('Ctrl+Shift+F opens the palette in Search all chats, also when it is open on the commands', () => {
    press({ key: 'F', ctrlKey: true, shiftKey: true });
    expect(palette()?.dataset.mode).toBe('chats');
    press({ key: 'k', ctrlKey: true });
    press({ key: 'k', ctrlKey: true });
    press({ key: 'f', ctrlKey: true, shiftKey: true });
    expect(palette()?.dataset.mode).toBe('chats');
  });

  it('Ctrl+F and Ctrl+Alt+Shift+F do nothing', () => {
    press({ key: 'f', ctrlKey: true });
    press({ key: 'f', ctrlKey: true, shiftKey: true, altKey: true });
    expect(palette()).toBeNull();
  });

  it('? and Ctrl+/ open the keyboard shortcuts sheet, and typing ? in a text box does not', () => {
    const sheet = () => host.querySelector<HTMLElement>('.ck-sheet--shortcuts');
    expect(sheet()).toBeNull();
    press({ key: '?' });
    expect(sheet()).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(sheet()).toBeNull();
    press({ key: '/', ctrlKey: true });
    expect(sheet()).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    const field = document.createElement('input');
    document.body.appendChild(field);
    act(() => void field.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true })));
    expect(sheet()).toBeNull();
    field.remove();
  });
});

describe('CockpitApp keyboard moves between agents', () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));

  it('Alt+Shift+Down goes to the next agent and Alt+Shift+Up back, wrapping round', () => {
    expect(mainText()).toBe('PANE VIEW p1');
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p2');
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p1');
    press({ key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Alt+Shift+2 jumps to agent number 2, and a number past the end does nothing', () => {
    press({ key: '@', code: 'Digit2', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p2');
    press({ key: '#', code: 'Digit3', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Alt+Shift+I opens the Inbox', () => {
    press({ key: 'I', altKey: true, shiftKey: true });
    expect(mainText()).toContain('INBOX VIEW');
  });

  it('says so when no agent needs you', () => {
    live.notes.length = 0;
    press({ key: 'N', altKey: true, shiftKey: true });
    expect(live.notes).toContain('Nothing needs you right now');
  });

  it('the keys follow the person\'s own choice', async () => {
    const { setKeybindings } = await import('./lib/shortcuts');
    act(() => setKeybindings({ 'pane-next': 'Mod+Alt+J' }));
    press({ key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(mainText()).toBe('PANE VIEW p1');
    press({ key: 'j', ctrlKey: true, altKey: true });
    expect(mainText()).toBe('PANE VIEW p2');
    act(() => setKeybindings({}));
  });
});

describe('CockpitApp split view wiring', () => {
  const ctrlBackslash = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', ctrlKey: true, bubbles: true }));
  const resize = (width: number) => {
    window.innerWidth = width;
    act(() => window.dispatchEvent(new Event('resize')));
  };
  afterEach(() => resize(1024));

  it('Ctrl+\\ splits with the pane below the selected one (the first pane has none above), and again closes it', () => {
    expect(mainText()).toBe('PANE VIEW p1');
    act(() => ctrlBackslash());
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left');
    act(() => ctrlBackslash());
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('"Open to the side" puts that pane on the right, and a click on the right side moves the focus', () => {
    clickButton('Open p2 to the side');
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left');
    clickButton('Focus right');
    expect(mainText()).toContain('SPLIT VIEW p1|p2|right');
  });

  it('a chat dragged onto the right half opens beside the selected one; onto the left half it takes the left', () => {
    workAreaRect();
    const move = (type: string, x: number) => act(() => void window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 50, button: 0 })));
    act(() => startDrag({ kind: 'chat', id: 'p2', label: 'p2' }, { clientX: 10, clientY: 10, button: 0 }));
    move('pointermove', 700);
    move('pointerup', 700);
    move('click', 700); // a browser always sends the click that follows a release
    expect(mainText()).toContain('SPLIT VIEW p1|p2|right');
    act(() => startDrag({ kind: 'chat', id: 'p2', label: 'p2' }, { clientX: 10, clientY: 10, button: 0 }));
    move('pointermove', 200);
    move('pointerup', 200);
    move('click', 200);
    expect(mainText()).toContain('SPLIT VIEW p2|p1|left');
    vi.restoreAllMocks();
  });

  it('picking the right pane in the sidebar swaps the sides; the inbox ends the split', () => {
    clickButton('Open p2 to the side');
    clickButton('pane p2');
    expect(mainText()).toContain('SPLIT VIEW p2|p1|left');
    clickButton('Inbox');
    expect(mainText()).not.toContain('SPLIT VIEW');
    expect(mainText()).toContain('INBOX VIEW');
  });

  it('below 900px the shortcut does nothing, and an open split turns off when the window gets narrow', () => {
    resize(800);
    act(() => ctrlBackslash());
    expect(mainText()).toBe('PANE VIEW p1');
    resize(1024);
    act(() => ctrlBackslash());
    expect(mainText()).toContain('SPLIT VIEW');
    resize(800);
    expect(mainText()).toBe('PANE VIEW p1');
  });
});

describe('CockpitApp layout: panel widths, focus mode and swapping the sides', () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  const cockpitEl = () => host.querySelector<HTMLElement>('.cockpit')!;
  const handle = () => host.querySelector<HTMLElement>('[role="separator"][aria-label="Resize the sidebar"]')!;
  const focusing = () => cockpitEl().hasAttribute('data-focus-mode');
  beforeEach(() => {
    window.innerWidth = 1280;
    act(() => window.dispatchEvent(new Event('resize')));
  });
  afterEach(() => {
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    window.innerWidth = 1024;
    act(() => window.dispatchEvent(new Event('resize')));
    localStorage.clear();
    act(() => resetSideWidth());
  });

  it('the sidebar has a handle: arrow keys widen it, Home goes to the smallest, double-click resets, and it is remembered', () => {
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('240px');
    expect(handle().getAttribute('aria-valuenow')).toBe('240');
    act(() => handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('256px');
    expect(localStorage.getItem('pm.sidebar.width')).toBe('256');
    act(() => handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('180px');
    act(() => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('240px');
  });

  it('dragging the sidebar very narrow makes it the thin icon strip, and dragging out brings it back', () => {
    act(() => setSideWidth(100));
    expect(cockpitEl().hasAttribute('data-side-strip')).toBe(true);
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('52px');
    act(() => setSideWidth(260));
    expect(cockpitEl().hasAttribute('data-side-strip')).toBe(false);
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('260px');
  });

  it('Ctrl+Shift+Enter fills the window with the open pane; Esc and the button bring the layout back', () => {
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(focusing()).toBe(true);
    expect(cockpitEl().style.getPropertyValue('--ck-side-w')).toBe('0px');
    expect(host.querySelector('.ck-resize--side')).toBeNull();
    press({ key: 'Escape' });
    expect(focusing()).toBe(false);
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    clickButton('Exit focus mode');
    expect(focusing()).toBe(false);
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(focusing()).toBe(false);
  });

  it('focus mode ends when the Inbox opens', () => {
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(focusing()).toBe(true);
    clickButton('Inbox');
    expect(focusing()).toBe(false);
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    expect(focusing()).toBe(false);
  });

  it('Esc is left alone while a sheet is open', () => {
    press({ key: 'Enter', ctrlKey: true, shiftKey: true });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    press({ key: 'Escape' });
    expect(focusing()).toBe(true);
    dialog.remove();
    press({ key: 'Escape' });
    expect(focusing()).toBe(false);
  });

  it('Ctrl+Alt+X swaps the two chats of a split view; the chat that had the focus keeps it', () => {
    clickButton('Open p2 to the side');
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left');
    press({ key: 'x', ctrlKey: true, altKey: true });
    expect(mainText()).toContain('SPLIT VIEW p2|p1|right');
    press({ key: 'x', ctrlKey: true, altKey: true });
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left');
  });

  it('Ctrl+Alt+X does nothing without a split view', () => {
    press({ key: 'x', ctrlKey: true, altKey: true });
    expect(mainText()).toBe('PANE VIEW p1');
  });
});

// The segment controls of the Go live sheet measure themselves with a ResizeObserver, which jsdom does not have.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('CockpitApp Live Room wiring', () => {
  const flush = () =>
    act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  /** The app tells every window the room changed (`live://state`). */
  const emit = (over: Partial<LiveStatus>) =>
    act(async () => {
      const next = { ...live.status, ...over };
      live.status = next;
      live.listeners.forEach((cb) => cb(next));
    });
  const bar = () => host.querySelector('.ck-live-bar');
  const running = (over: Partial<LiveStatus> = {}): Partial<LiveStatus> => ({ live: true, viewers: 7, endsAtMs: Date.now() + 41 * 60_000, paneIds: ['p1'], stopped: null, ...over });

  it('shows no LIVE bar while there is no room', async () => {
    await flush();
    expect(bar()).toBeNull();
  });

  it('the LIVE bar appears on a live://state event and goes on stop, with the reason toast', async () => {
    await flush();
    await emit(running());
    expect(bar()?.textContent).toContain('LIVE');
    expect(bar()?.textContent).toContain('7 watching');
    expect(bar()?.textContent).not.toMatch(/https?:|#/);
    expect(live.notes).toEqual([]);
    await emit({ live: false, paused: false, stopped: 'expired' });
    expect(bar()).toBeNull();
    expect(live.notes).toEqual(['Live Room ended: time is up.']);
  });

  it('says each stop in plain English, and nothing when the app quits', async () => {
    await flush();
    await emit(running());
    await emit({ live: false, stopped: 'idle' });
    await emit(running());
    await emit({ live: false, stopped: 'app_quit' });
    await emit(running());
    await emit({ live: false, stopped: 'owner' });
    expect(live.notes).toEqual(['Live Room stopped: nothing happened for 20 minutes.', 'Live Room stopped.']);
  });

  it('a stopped status seen at start (no room before) says nothing', async () => {
    await flush();
    await emit({ live: false, stopped: 'expired' });
    expect(live.notes).toEqual([]);
  });

  it('Stop in the LIVE bar ends the room through the app', async () => {
    await flush();
    await emit(running());
    await act(async () => clickButton('Stop'));
    expect(live.stops).toBe(1);
  });

  it('the Go live event (chat menu, palette) opens the sheet with that pane checked', async () => {
    await flush();
    act(() => requestGoLive('p2'));
    await flush();
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.textContent).toContain('Go live');
    const boxes = [...(sheet?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
  });

  it('the Go live event with no pane checks the selected pane', async () => {
    await flush();
    act(() => requestGoLive(null));
    await flush();
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });

  it('while a room runs, the Go live event opens nothing and says why', async () => {
    await flush();
    await emit(running());
    act(() => requestGoLive('p1'));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(live.notes).toEqual(['Live Room is already running. Stop it first.']);
  });
});

describe('CockpitApp old chats host', () => {
  it('shows no old chat sheet without a request', () => {
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a request opens the sheet, Continue starts the pane with the plan and selects it, and the sheet is gone', async () => {
    imp.spawnPane = vi.fn(async () => 'p2');
    act(() => requestImportedChat('codex', 'sess-0001-abcd'));
    expect(host.textContent).toContain('OLD CHAT codex/sess-0001-abcd');
    await act(async () => clickButton('Continue here'));
    expect(imp.spawnPane).toHaveBeenCalledWith({ agent_type: 'codex', cwd: 'C:/Users/you/shop', extra_args: ['resume', 'sess-0001-abcd'] });
    expect(mainText()).toBe('PANE VIEW p2');
    expect(host.textContent).not.toContain('OLD CHAT');
  });

  it('closing the sheet clears the request, and the Bring-chats request shows its panel', () => {
    act(() => requestImportedChat('codex', 'sess-0001-abcd'));
    clickButton('Close old chat');
    expect(host.textContent).not.toContain('OLD CHAT');
    act(() => requestBringChats());
    expect(host.textContent).toContain('BRING PANEL');
    clickButton('Close bring');
    expect(host.textContent).not.toContain('BRING PANEL');
  });
});

describe('CockpitApp New agent page wiring', () => {
  const findButton = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  const ctrlN = (target: EventTarget = window, init: KeyboardEventInit = {}) =>
    act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true, ...init })));

  it('the sidebar row opens the page and marks its row active; the Inbox row leaves it', async () => {
    await act(async () => root.render(createElement(CockpitApp)));
    expect(mainText()).not.toContain('NEW AGENT PAGE');
    clickButton('New agent row');
    expect(mainText()).toContain('NEW AGENT PAGE');
    expect(findButton('New agent row')?.getAttribute('aria-current')).toBe('page');
    clickButton('Inbox');
    expect(mainText()).not.toContain('NEW AGENT PAGE');
  });

  const menuAsked = () => {
    const seen = vi.fn();
    window.addEventListener('pm:open-new-menu', seen);
    return { seen, stop: () => window.removeEventListener('pm:open-new-menu', seen) };
  };

  it('Ctrl+N opens the page, from a pane too, and does not open the quick menu', async () => {
    await act(async () => root.render(createElement(CockpitApp)));
    const m = menuAsked();
    ctrlN();
    m.stop();
    expect(mainText()).toContain('NEW AGENT PAGE');
    expect(mainText()).not.toContain('project:');
    expect(m.seen).not.toHaveBeenCalled();
  });

  it('Ctrl+N inside a terminal is the terminal’s own key', async () => {
    await act(async () => root.render(createElement(CockpitApp)));
    const term = document.createElement('div');
    term.className = 'terminal-host';
    const inner = document.createElement('textarea');
    term.appendChild(inner);
    document.body.appendChild(term);
    ctrlN(inner);
    term.remove();
    expect(mainText()).not.toContain('NEW AGENT PAGE');
  });

  it('Shift or Alt with Ctrl+N is not ours', async () => {
    await act(async () => root.render(createElement(CockpitApp)));
    ctrlN(window, { shiftKey: true });
    ctrlN(window, { altKey: true });
    expect(mainText()).not.toContain('NEW AGENT PAGE');
  });

  it('the page’s Set up agents row opens the Agent Doctor', async () => {
    await act(async () => root.render(createElement(CockpitApp)));
    clickButton('New agent row');
    clickButton('Page set up');
    expect(mainText()).toContain('DOCTOR VIEW');
  });
});

describe('Individual mode first-switch sheet', () => {
  it('shows the sheet when the hook says so; Switch passes Do not show again, Cancel closes', () => {
    const confirm = vi.fn(async () => {});
    const cancel = vi.fn();
    cockpit.explainer = { open: true, confirm, cancel };
    act(() => root.render(createElement(CockpitApp)));
    const dialog = host.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Each agent gets its own window');
    clickButton('Switch');
    expect(confirm).toHaveBeenCalledWith(true);
    clickButton('Cancel');
    expect(cancel).toHaveBeenCalledTimes(1);
    cockpit.explainer = { open: false, confirm, cancel };
  });
});

// The split grid (up to four chats): split down, close one, the keys, and the layout kept for the next start.
describe('CockpitApp split grid wiring', () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  const ctrlAltD = () => press({ key: 'd', ctrlKey: true, altKey: true });
  const ctrlAltW = () => press({ key: 'w', ctrlKey: true, altKey: true });
  beforeEach(async () => {
    // The mocked hook reads extraIds on render: set them, then draw once more.
    cockpit.extraIds = ['p3', 'p4'];
    await act(async () => root.render(createElement(CockpitApp, { key: 'grid' })));
  });
  afterEach(() => {
    cockpit.extraIds = [];
  });

  it('Ctrl+Alt+D opens the next chat below, then below the other column; a fifth is refused', () => {
    clickButton('Open p2 to the side');
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left|0.5');
    expect(mainText()).not.toContain('down:');
    ctrlAltD();
    expect(mainText()).toContain('SPLIT VIEW p1|p2|leftDown|0.5|down:p3,-');
    ctrlAltD();
    expect(mainText()).toContain('|down:p3,p4');
    ctrlAltD();
    expect(live.notes).toContain('Four chats are already open');
    expect(mainText()).toContain('|down:p3,p4');
  });

  it('the Split down button of a column opens a chat below it', () => {
    clickButton('Open p2 to the side');
    clickButton('Split down left');
    expect(mainText()).toContain('|down:p3,-');
  });

  it('Ctrl+Alt+D does nothing without a split view', () => {
    ctrlAltD();
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('Ctrl+Alt+W takes the focused chat out; the grid closes up and the last two stay split', () => {
    clickButton('Open p2 to the side');
    ctrlAltD();
    ctrlAltD();
    expect(mainText()).toContain('|down:p3,p4');
    ctrlAltW(); // focus is on the chat below the right column (p4)
    expect(mainText()).toContain('SPLIT VIEW p1|p2|left|0.5|down:p3,-');
    clickButton('Close focused chat'); // focus went back to the left top (p1): p3 moves up
    expect(mainText()).toContain('SPLIT VIEW p3|p2|left|0.5');
    expect(mainText()).not.toContain('down:');
    ctrlAltW(); // two chats: closing one ends the split and the other stays open
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('remembers the grid for the next start, and a plain split forgets it', () => {
    clickButton('Open p2 to the side');
    ctrlAltD();
    const saved = JSON.parse(localStorage.getItem('pm.cockpit.split') ?? 'null');
    expect(saved).toMatchObject({ left: 'p1', right: 'p2', below: { leftDown: 'p3', rightDown: null } });
    ctrlAltW();
    const plain = JSON.parse(localStorage.getItem('pm.cockpit.split') ?? 'null');
    expect(plain).toMatchObject({ left: 'p1', right: 'p2' });
    expect(plain.below).toBeUndefined();
  });
});

describe('CockpitApp: devices connected to this PC', () => {
  const show = async (devices: unknown[], enabled = true) => {
    dev.view = { enabled, devices };
    await act(async () => root.render(createElement(CockpitApp)));
  };

  it('shows who is connected above the work area, and Disconnect asks the backend to close it', async () => {
    const disconnect = vi.spyOn(devicesApi, 'disconnect').mockResolvedValue({} as never);
    await show([{ ...MAC_MINI, lets_run: true, level: 'watch', connected: true }]);
    const banner = host.querySelector('main [data-testid="connected-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Mac mini is using this PC');
    expect(banner!.textContent).not.toContain('watch and answer only');
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="disconnect-${NODE_MAC}"]`)!.click());
    expect(disconnect).toHaveBeenCalledWith(NODE_MAC);
    disconnect.mockRestore();
  });

  it('shows nothing while nobody is connected or the Labs switch is off', async () => {
    await show([{ ...MAC_MINI, lets_run: true, connected: false }]);
    expect(host.querySelector('[data-testid="connected-banner"]')).toBeNull();
    await show([{ ...MAC_MINI, lets_run: true, connected: true }], false);
    expect(host.querySelector('[data-testid="connected-banner"]')).toBeNull();
  });
});

// Drag an agent onto the work area: the four zones, the 50/50 reset, replacing a side, Esc, and the layouts they build.
describe('CockpitApp drop zones', () => {
  const press = (init: KeyboardEventInit) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })));
  const at = (type: string, x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0 })));
  /** Drags `id` from the sidebar to (x, y) and lets go there. */
  const dragTo = (id: string, x: number, y: number, finish = true) => {
    act(() => startDrag({ kind: 'chat', id, label: id }, { clientX: 10, clientY: 10, button: 0 }));
    at('pointermove', x, y);
    at('pointermove', x, y); // the drop target is drawn by the first move: the second one finds it
    if (!finish) return;
    at('pointerup', x, y);
    at('click', x, y);
  };
  const splitLine = () => [...host.querySelectorAll('main div')].map((d) => d.firstChild?.textContent ?? '').find((t) => t.startsWith('SPLIT VIEW')) ?? '';
  beforeEach(async () => {
    window.innerWidth = 1280;
    act(() => window.dispatchEvent(new Event('resize')));
    cockpit.extraIds = ['p3', 'p4'];
    workAreaRect();
    await act(async () => root.render(createElement(CockpitApp, { key: 'drops' })));
  });
  afterEach(() => {
    cockpit.extraIds = [];
    vi.restoreAllMocks();
    window.innerWidth = 1024;
    act(() => window.dispatchEvent(new Event('resize')));
  });

  it('right of the middle band opens beside, with the divider where it was left (58); the middle line resets it to 50', () => {
    clickButton('Open p2 to the side');
    clickButton('Set divider 58');
    expect(splitLine()).toContain('SPLIT VIEW p1|p2|left|0.58');
    clickButton('Close split');
    dragTo('p2', 800, 100);
    expect(splitLine()).toContain('SPLIT VIEW p1|p2|right|0.58');
    clickButton('Close split');
    dragTo('p2', 520, 100);
    expect(splitLine()).toContain('SPLIT VIEW p1|p2|right|0.5');
    expect(splitLine()).not.toContain('0.58');
  });

  it('left of the middle band puts the dragged chat on the left with the mirrored divider', () => {
    clickButton('Open p2 to the side');
    clickButton('Set divider 58');
    clickButton('Close split');
    dragTo('p2', 100, 100);
    expect(splitLine()).toMatch(/SPLIT VIEW p2\|p1\|left\|0\.42/);
  });

  it('the lowest part stacks two chats; a third goes below, full width; a fourth makes a 2 x 2', () => {
    dragTo('p2', 500, 500);
    expect(splitLine()).toBe('SPLIT VIEW p1|p2|right|0.5|stacked');
    dragTo('p3', 300, 500);
    expect(splitLine()).toBe('SPLIT VIEW p1|p2|leftDown|0.5|down:p3,-|wide');
    dragTo('p4', 300, 500);
    expect(splitLine()).toContain('|down:p3,p4');
    expect(splitLine()).not.toContain('|wide');
  });

  it('with two open, a drop on the left replaces the left chat and one on the right replaces the right one', () => {
    clickButton('Open p2 to the side');
    dragTo('p3', 100, 100);
    expect(splitLine()).toContain('SPLIT VIEW p3|p2|left');
    dragTo('p4', 800, 100);
    expect(splitLine()).toContain('SPLIT VIEW p3|p4|right');
    dragTo('p1', 500, 100); // the middle line also replaces the right one
    expect(splitLine()).toContain('SPLIT VIEW p3|p1|right|0.5');
  });

  it('dragging the only open chat brings the chat that was in front before to the other side', () => {
    clickButton('pane p2');
    clickButton('pane p1');
    dragTo('p1', 800, 100);
    expect(splitLine()).toContain('SPLIT VIEW p2|p1|right');
  });

  it('Esc during a drag leaves the layout alone, and so does letting go outside the work area', () => {
    dragTo('p2', 800, 100, false);
    expect(host.querySelector('[data-testid="drop-take"]')).not.toBeNull();
    press({ key: 'Escape' });
    at('pointerup', 800, 100);
    expect(host.querySelector('[data-testid="drop-take"]')).toBeNull();
    expect(mainText()).toBe('PANE VIEW p1');
    dragTo('p2', 1500, 100);
    expect(mainText()).toBe('PANE VIEW p1');
  });

  it('shows the live preview while dragging, and nothing after the drop', () => {
    dragTo('p2', 500, 100, false);
    const zone = () => host.querySelector('[data-testid="work-drop"]')?.getAttribute('data-zone');
    expect(zone()).toBe('mid');
    expect(host.querySelector('[data-testid="drop-take"]')?.textContent).toBe('p2 · half and half');
    at('pointermove', 800, 100);
    expect(zone()).toBe('right');
    at('pointermove', 800, 480);
    expect(zone()).toBe('down');
    at('pointerup', 800, 480);
    at('click', 800, 480);
    expect(host.querySelector('[data-testid="work-drop"]')).toBeNull();
  });

  it('the row menu has the keyboard way: open on the left, open below', () => {
    clickButton('Open p2 on the left');
    expect(splitLine()).toContain('SPLIT VIEW p2|p1|left');
    clickButton('Open p3 below');
    expect(splitLine()).toContain('|down:p3,-|wide');
  });
});

// The helpers bar above the work area: helpers only, standby helpers, kept in split view.
describe('CockpitApp helpers bar', () => {
  const bar = () => host.querySelector<HTMLElement>('[data-testid="helpers-bar"]');
  const chips = () => [...host.querySelectorAll<HTMLElement>('[data-testid="helpers-bar"] [data-pane-tab]')].map((el) => el.getAttribute('data-pane-tab'));
  const crumb = () => host.querySelector('[data-testid="helpers-crumb"]')?.textContent;
  const rerender = async (key: string) => act(async () => root.render(createElement(CockpitApp, { key })));
  afterEach(() => {
    act(() => setStandbys([]));
    cockpit.extraIds = [];
    window.innerWidth = 1024;
    act(() => window.dispatchEvent(new Event('resize')));
  });

  it('is not drawn when the agent has no helpers and there are no standbys', () => {
    expect(bar()).toBeNull();
  });

  it('shows the crumb and a chip for each helper; the main agent is never a chip', async () => {
    cockpit.parents = { p2: 'p1' };
    cockpit.statuses = { p2: 'running' };
    await rerender('h1');
    expect(bar()).not.toBeNull();
    expect(crumb()).toBe('agent-p1');
    expect(chips()).toEqual(['p2']);
    expect(host.querySelector('[data-testid="helper-dot"]')).not.toBeNull();
  });

  it('a minion is not a chip (it lives in Background tasks); a spin-off and a helper still are', async () => {
    cockpit.extraIds = ['p3', 'p4'];
    cockpit.parents = { p2: 'p1', p3: 'p1', p4: 'p1' };
    cockpit.startedAs = { p2: 'minion', p3: 'spin_off' };
    await rerender('minion');
    expect(chips()).toEqual(['p3', 'p4']);
    // With only a minion under it, the agent has no bar at all.
    cockpit.extraIds = [];
    cockpit.parents = { p2: 'p1' };
    await rerender('minion-only');
    expect(bar()).toBeNull();
  });

  it('a chip opens that helper in the front pane, and the crumb brings the main agent back', async () => {
    cockpit.parents = { p2: 'p1' };
    await rerender('h2');
    act(() => host.querySelector<HTMLButtonElement>('[data-pane-tab="p2"] [role="tab"]')!.click());
    expect(host.querySelector('.ck-hchip.is-on')?.getAttribute('data-pane-tab')).toBe('p2');
    // The helper is in front, and the crumb still names the main agent it belongs to: the way back.
    expect(crumb()).toBe('agent-p1');
    expect(host.querySelector('[data-testid="helpers-crumb"]')?.className).not.toContain('is-on');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="helpers-crumb"]')!.click());
    expect(host.querySelector('[data-testid="helpers-crumb"]')?.className).toContain('is-on');
    expect(host.querySelector('.ck-hchip.is-on')).toBeNull();
  });

  it('standby helpers show as outlined Ready chips, even with no helpers of the agent', async () => {
    // With the sidebar list off the bar holds the standbys (with it on, the sidebar rows do).
    setHelpersInSidebar(false);
    act(() => setStandbys([{ id: 's1', agent: 'codex', name: 'Reviewer', state: 'ready' }]));
    await rerender('s1');
    const chip = host.querySelector('[data-testid="standby-chip"]');
    expect(chip?.textContent).toContain('Reviewer');
    expect(chip?.textContent).toContain('Ready');
    expect(chips()).toEqual([]);
    setHelpersInSidebar(true);
  });

  it('stays in split view and follows the focused pane: focusing the other side swaps the crumb and the chips', async () => {
    cockpit.extraIds = ['p3', 'p4'];
    cockpit.parents = { p2: 'p1', p4: 'p3' };
    window.innerWidth = 1280;
    act(() => window.dispatchEvent(new Event('resize')));
    await rerender('split');
    clickButton('Open p3 to the side');
    expect(host.textContent).toContain('SPLIT VIEW p1|p3|left');
    expect(bar()).not.toBeNull();
    expect(crumb()).toBe('agent-p1');
    expect(chips()).toEqual(['p2']);
    clickButton('Focus right');
    expect(crumb()).toBe('agent-p3');
    expect(chips()).toEqual(['p4']);
    clickButton('Focus left');
    expect(crumb()).toBe('agent-p1');
  });

  it('a chip click in a split replaces the focused side', async () => {
    cockpit.extraIds = ['p3'];
    cockpit.parents = { p3: 'p2' };
    window.innerWidth = 1280;
    act(() => window.dispatchEvent(new Event('resize')));
    await rerender('split2');
    clickButton('Open p2 to the side');
    clickButton('Focus right');
    act(() => host.querySelector<HTMLButtonElement>('[data-pane-tab="p3"] [role="tab"]')!.click());
    expect(host.textContent).toContain('SPLIT VIEW p1|p3|right');
  });
});

describe('CockpitApp: more than one companion', () => {
  const companion = (id: string, name: string, isDefault: boolean) => ({
    id,
    name,
    avatar: 'mochi',
    isDefault,
    persona: 'calm',
    agentType: 'claude',
    agentLabel: 'Claude',
    folder: 'C:\\work\\home',
    folderName: 'home',
    state: 'sleeping',
    stateLine: 'Asleep',
    paneId: null,
    needs: null,
    pendingMemory: 0,
    nextCheckin: null,
    restarts: 0,
    autoStart: true,
  });
  const show = async () => {
    comps.list = [companion('mochi', 'Mochi', true), companion('bit', 'Bit', false)];
    await act(async () => root.render(createElement(CockpitApp)));
    await act(async () => {});
  };

  it('"New companion" opens the setup sheet as "Make another companion", and Cancel closes it', async () => {
    await show();
    clickButton('New companion row');
    await act(async () => {});
    expect(host.textContent).toContain('Make another companion');
    expect(host.textContent).toContain('Start from');
    clickButton('Cancel');
    expect(host.textContent).not.toContain('Make another companion');
  });

  it('a companion row opens its page with the switcher, and the switcher goes to the other companion', async () => {
    await show();
    clickButton('companion Mochi');
    await act(async () => {});
    expect(host.querySelector('.ck-companion-name')?.textContent).toBe('Mochi');
    expect(host.querySelector('.ck-companion-badge')?.textContent).toBe('Default');
    clickButton('Switch companion ▾');
    const bit = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent === 'Bit')!;
    act(() => bit.click());
    await act(async () => {});
    expect(host.querySelector('.ck-companion-name')?.textContent).toBe('Bit');
    expect(host.querySelector('.ck-companion-badge')).toBeNull();
  });
});

describe('CockpitApp: Leaving my desk', () => {
  const state = (over: Partial<DeskAway> = {}): DeskAway => ({ away: false, lock_screen: false, phones: 1, ...over });
  const bar = () => host.querySelector('.cockpit > .ck-statusbar');
  const chip = () => bar()?.querySelector<HTMLButtonElement>('[data-testid="desk-chip"]') ?? null;
  const banner = () => host.querySelector('[data-testid="desk-banner"]');
  const sheet = () => document.querySelector('[data-testid="desk-sheet"]');
  const setServerState = async (next: DeskAway) => {
    vi.spyOn(tauri, 'getDeskAway').mockResolvedValue(next);
    await act(async () => deskStore().refresh());
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    setDeskSheetOpen(false);
    await act(async () => {
      vi.spyOn(tauri, 'getDeskAway').mockResolvedValue(NOT_AWAY);
      await deskStore().refresh();
    });
    vi.restoreAllMocks();
  });

  it('has no chip while no phone is paired', async () => {
    await setServerState(state({ phones: 0 }));
    expect(chip()).toBeNull();
    expect(banner()).toBeNull();
  });

  it('the chip in the status bar asks how long, hands the day to the phone, and shows "Away · phone has control" with I\'m back', async () => {
    await setServerState(state());
    expect(chip()!.textContent).toBe('Leaving my desk');
    expect(banner()).toBeNull();
    await act(async () => chip()!.click());
    expect(sheet()).not.toBeNull();
    const radios = [...sheet()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(["Until I'm back", '1 hour', '4 hours', 'Tonight, until 6 am']);
    await act(async () => radios[2].click());
    await act(async () => sheet()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const start = vi.spyOn(tauri, 'startDeskAway').mockResolvedValue(state({ away: true, length: 'four_hours', until_ms: Date.now() + 4 * 3_600_000, by: 'pc', lock_screen: true }));
    await act(async () => sheet()!.querySelector<HTMLButtonElement>('[data-testid="desk-start"]')!.click());
    expect(start).toHaveBeenCalledWith('four_hours', true);
    expect(sheet()).toBeNull();
    expect(banner()!.textContent).toContain('Away · phone has control');
    expect(banner()!.textContent).toContain('Screen control is locked');
    expect(chip()).toBeNull();

    const end = vi.spyOn(tauri, 'endDeskAway').mockResolvedValue(state());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="desk-back"]')!.click());
    expect(end).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
    expect(chip()).not.toBeNull();
  });

  it('a switch the phone flipped says so, and "until I\'m back" shows no time', async () => {
    await setServerState(state({ away: true, length: 'until_back', until_ms: null, by: 'phone', device_name: 'Mia' }));
    expect(banner()!.textContent).toContain('your phone switched this on');
    expect(banner()!.textContent).toContain("Until you press I'm back");
  });

  it('a switch whose time has passed is not shown, even before the PC says it ended', async () => {
    await setServerState(state({ away: true, length: 'one_hour', until_ms: Date.now() - 1000, by: 'pc' }));
    expect(banner()).toBeNull();
    expect(chip()).not.toBeNull();
  });
});

describe('CockpitApp: the Join popup', () => {
  const LINK = 'https://pm-relay.maya.workers.dev/join/ABCDEFGH23456789';
  const popup = () => host.querySelector('[data-testid="join-popup"]');

  it('a delivered invite link shows "Join?" on whatever screen is open, not only on Connect › Team', async () => {
    expect(mainText()).toBe('PANE VIEW p1');
    expect(popup()).toBeNull();
    await act(async () => void window.dispatchEvent(new CustomEvent('pm:join-link', { detail: LINK })));
    expect(popup()).not.toBeNull();
    // It sits in a frame that takes no room and does not block the page behind it.
    expect(host.querySelector('[data-testid="cockpit-join-host"]')?.className).toContain('jl-host');
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(popup()).toBeNull();
  });

  it('text that is not a Worker invite link is dropped before anything is asked of the network', async () => {
    await act(async () => void window.dispatchEvent(new CustomEvent('pm:join-link', { detail: 'https://evil.example/not-a-join' })));
    expect(popup()).toBeNull();
    await act(async () => void window.dispatchEvent(new CustomEvent('pm:join-link', { detail: { link: LINK } })));
    expect(popup()).toBeNull();
  });

  describe('a link the operating system opened (potato-workspace://join/...)', () => {
    const DEEP = 'potato-workspace://join/ABCDEFGH23456789?w=pm-relay.maya.workers.dev';
    const inShell = () => (window as unknown as Record<string, unknown>);
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    afterEach(() => {
      delete inShell().__TAURI_INTERNALS__;
      shell.handlers.clear();
      shell.pending = null;
    });

    it('a link sent by the shell while the app runs shows the popup', async () => {
      inShell().__TAURI_INTERNALS__ = {};
      await act(async () => void root.render(createElement(CockpitApp, { key: 'shell' })));
      await settle();
      expect(shell.handlers.has('pm-join-link')).toBe(true);
      expect(popup()).toBeNull();
      await act(async () => void shell.handlers.get('pm-join-link')!({ payload: DEEP }));
      expect(popup()).not.toBeNull();
    });

    it('a link that came before the window was ready shows the popup once the window opens', async () => {
      inShell().__TAURI_INTERNALS__ = {};
      shell.pending = DEEP;
      await act(async () => void root.render(createElement(CockpitApp, { key: 'shell' })));
      await settle();
      expect(popup()).not.toBeNull();
    });

    it('a payload that is not an invite link shows nothing', async () => {
      inShell().__TAURI_INTERNALS__ = {};
      await act(async () => void root.render(createElement(CockpitApp, { key: 'shell' })));
      await settle();
      await act(async () => void shell.handlers.get('pm-join-link')!({ payload: 'potato-workspace://open/ABCDEFGH23456789?w=pm-relay.maya.workers.dev' }));
      await act(async () => void shell.handlers.get('pm-join-link')!({ payload: { link: DEEP } }));
      expect(popup()).toBeNull();
    });
  });
});

// Inbox rows open their chat (the 1.1.1 redesign: only a hover-only button did). Through the real Inbox in the real cockpit.
describe('Inbox rows open their chat', () => {
  const NOW = new Date(2026, 10, 16, 14, 30, 0).getTime();
  const at = (h: number, m: number) => new Date(2026, 10, 16, h, m, 0).getTime();
  const turn = (paneId: string, agent: string, endedAtMs: number) => ({ paneId, agent, turn: 1, startedAtMs: endedAtMs - 60_000, endedAtMs, durationMs: 60_000, files: null, approvals: [], end: { kind: 'idle' }, sentence: 'Done.' });
  const openInbox = () => {
    inb.real = true;
    inb.now = NOW;
    inb.names = new Map([['p2', 'Word viewer pages']]);
    inb.turns = new Map([['p2', turn('p2', 'codex', at(11, 40))], ['gone', turn('gone', 'claude', at(10, 5))]]);
    localStorage.setItem('pm.cockpit.everSpawned', '1');
    act(() => root.render(createElement(CockpitApp)));
    clickButton('Inbox');
    expect(mainText()).toContain('Done today');
  };
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-done-row="${id}"]`)!;

  it('clicking a Done today row opens its chat in the work area', () => {
    openInbox();
    act(() => row('p2').click());
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('Enter on a focused Done today row opens its chat', () => {
    openInbox();
    act(() => {
      row('p2').focus();
      row('p2').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('the row button still opens it, once', () => {
    openInbox();
    act(() => row('p2').querySelector<HTMLButtonElement>('button')!.click());
    expect(mainText()).toBe('PANE VIEW p2');
  });

  it('a row of a closed chat says so and stays on the Inbox', () => {
    openInbox();
    act(() => row('gone').click());
    expect(inb.notes).toContain('This chat is closed.');
    expect(mainText()).toContain('Done today');
  });
});
