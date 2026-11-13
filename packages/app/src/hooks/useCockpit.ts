// State for the cockpit window: panes (via usePaneRegistry), selection, prompts, mode, theme,
// warm-ready agents and the spawn flow. Backend data only; nothing is invented client-side
// except "status entered at" timestamps, which are measured from what this window observed.
import { errorSentence } from '../lib/sayError';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePaneRegistry, type PaneRegistryApi } from './usePaneRegistry';
import { paneMenuEntries, useAgentRegistry, agentLabel, type LaunchEntry } from '../lib/agentRegistry';
import { usePanePreviews, type PreviewMap } from '../lib/pane-preview';
import { cockpitApi, type PanePrompt, type SpawnStageEvent, type UiMode } from '../lib/cockpit-api';
import { applyTheme, loadSettings, patchSettings, type AppTheme } from '../lib/settings';
import { subscribeSettingsTheme } from '../lib/settings-sync';
import { tauri } from '../lib/tauri';
import { useBridge, type BridgeApi } from './useBridge';
import { useQuestions, type QuestionsApi } from './useQuestions';
import { paneNames } from '../components/cockpit/model';
import { visibleSelection } from '../components/cockpit/selection';
import { forgetTerminal } from '../components/cockpit/session-memory';
import { usePaneActivity, type ActivityMap } from '../lib/pane-activity';
import type { UserGesture } from '../lib/user-gesture';
import { useChatStarts, type ChatStartState } from './useChatStarts';

/** How long after an answer landed further clicks on the same card are ignored (the TUI redraws
 *  the dialog away within this; the backend's own window is 5 s). */
const ANSWER_SETTLE_MS = 2_000;
/** How long after an answer the screen is read again. The backend takes a repeat of the same answer as a duplicate for
 *  5 s (`DEDUPE_WINDOW_MS`), so a retry offered earlier would send nothing. */
const ANSWER_CHECK_MS = 5_500;

/** How often a waiting pane with no card is looked at again (a question whose card went missing comes back). */
const PROMPT_RECHECK_MS = 2_000;
/** A card just answered is not put back by a re-read for this long (the TUI redraws the dialog away within it). */
const ANSWERED_HOLD_MS = 10_000;

export interface SpawnState {
  agentId: string;
  paneId: string | null;
  log: { stage: SpawnStageEvent['stage']; message?: string; warm: boolean; at: number }[];
  failed: string | null;
}

export type { ChatStartState } from './useChatStarts';

export interface Toast {
  id: number;
  text: string;
  /** A button on the toast (for example "Undo"). The toast stays longer so it can be reached. */
  action?: { label: string; run: () => void };
}

export interface CockpitApi {
  /** Questions agents asked the human through `ask_user`. */
  asked: QuestionsApi;
  registry: PaneRegistryApi;
  names: Map<string, string>;
  /** Plain-language activity phrase per pane id. */
  activities: ActivityMap;
  /** Dev-server URLs per pane id (newest first). */
  previews: PreviewMap;
  launchEntries: LaunchEntry[];
  /** Agent ids with at least one warm standby ready. */
  readyAgents: Set<string>;
  mode: UiMode;
  theme: AppTheme;
  selectedId: string | null;
  select: (paneId: string | null) => void;
  prompts: Record<string, PanePrompt | null>;
  statusSince: Map<string, number>;
  now: number;
  spawn: SpawnState | null;
  dismissSpawn: () => void;
  /** A chat that is starting now (null when none). Cleared by `endChatStart` on success or failure. */
  chatStarting: ChatStartState | null;
  /** Returns this start's id; pass it to `endChatStart` so two starts at once do not end each other. */
  beginChatStart: (agentId: string, folder: string) => string;
  endChatStart: (startId?: string) => void;
  toasts: Toast[];
  notify: (text: string, action?: Toast['action']) => void;
  /** Switch the UI mode. The first switch to Individual from here opens `modeExplainer` instead of switching. */
  setMode: (mode: UiMode) => Promise<void>;
  /** The first-switch sheet for Individual mode: `open` while it is up; Switch applies the mode, Cancel closes it. */
  modeExplainer: { open: boolean; confirm: (dontShowAgain: boolean) => Promise<void>; cancel: () => void };
  toggleTheme: () => Promise<void>;
  /** Opens a new agent pane. Resolves to its pane id, or null when it could not start (the starting view says why). */
  newAgent: (agentId: string, accountId?: string, isolated?: boolean, projectPath?: string, model?: string) => Promise<string | null>;
  /** A person's answer to a pane prompt; `gesture` is their click (`lib/user-gesture.ts`). */
  answer: (paneId: string, promptId: string, choiceId: string, label: string, gesture: UserGesture) => Promise<void>;
  interrupt: (paneId: string) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  /** Give a pane your own name (blank clears it). */
  rename: (paneId: string, title: string) => Promise<void>;
  /** Orchestration: Settings opens inside the cockpit (on `tab` when given). Individual: the Settings window. */
  openSettings: (tab?: string) => Promise<void>;
  /** Empty while the bridge works (or is still connecting); "Not connected" when it is down. */
  bridgeLine: string;
}

/** "Not connected" while a live bridge has dropped, '' otherwise (including before anything was set up). */
export function bridgeLineFor(bridge: Pick<BridgeApi, 'connectionLost'>): string {
  return bridge.connectionLost ? 'Not connected' : '';
}

export function useCockpit(): CockpitApi {
  const registry = usePaneRegistry();
  const activities = usePaneActivity();
  const previews = usePanePreviews();
  const listing = useAgentRegistry();
  const launchEntries = useMemo(() => paneMenuEntries(listing), [listing]);
  const { paneList, panes, initialReady } = registry;

  const [mode, setModeState] = useState<UiMode>('orchestration');
  const [theme, setTheme] = useState<AppTheme>('dark');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<Record<string, PanePrompt | null>>({});
  const [statusSince, setStatusSince] = useState<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [readyAgents, setReadyAgents] = useState<Set<string>>(new Set());
  const [spawn, setSpawn] = useState<SpawnState | null>(null);
  const chatStarts = useChatStarts();
  const chatStarting = chatStarts.chatStarting;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [explainerOpen, setExplainerOpen] = useState(false);
  // `individual_explained` from settings: the sheet was dismissed for good.
  const explainedRef = useRef(false);
  const bridge = useBridge();
  // Said only when a bridge that was up has stopped answering. A fresh install has no bridge yet and shows nothing;
  // the address is never shown here (it is in Settings > Bridge & MCP).
  const bridgeLine = bridgeLineFor(bridge);

  const spawnRef = useRef(spawn);
  spawnRef.current = spawn;
  const toastId = useRef(0);
  const lastStatus = useRef(new Map<string, string>());

  const notify = useCallback((text: string, action?: Toast['action']) => {
    const id = ++toastId.current;
    const dismiss = () => setToasts((t) => t.filter((x) => x.id !== id));
    // Using the action closes its toast, so Undo cannot be pressed twice.
    const wrapped = action && { label: action.label, run: () => (dismiss(), action.run()) };
    setToasts((t) => [...t.slice(-2), { id, text, action: wrapped }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 12000 : 3200);
  }, []);

  const names = useMemo(() => paneNames(paneList, (id) => agentLabel(listing, id)), [paneList, listing]);

  // Clock for "waiting 2m" text.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Status-entered timestamps, measured client-side from what this window observed.
  useEffect(() => {
    const prev = lastStatus.current;
    const changed: string[] = [];
    const seen = new Set<string>();
    for (const p of paneList) {
      seen.add(p.info.id);
      if (prev.get(p.info.id) !== p.status) changed.push(p.info.id);
      prev.set(p.info.id, p.status);
    }
    let gone = false;
    for (const id of [...prev.keys()]) {
      if (!seen.has(id)) {
        prev.delete(id);
        gone = true;
      }
    }
    if (!changed.length && !gone) return;
    const at = Date.now();
    setStatusSince((old) => {
      const next = new Map<string, number>();
      for (const p of paneList) {
        const id = p.info.id;
        next.set(id, changed.includes(id) ? at : (old.get(id) ?? at));
      }
      return next;
    });
  }, [paneList]);

  // Mode + theme at startup, then follow mode changes.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    cockpitApi.getUiMode().then((m) => !disposed && setModeState(m)).catch(() => {});
    void cockpitApi.onModeChanged((e) => setModeState(e.mode)).then((u) => (disposed ? u() : (off = u)));
    loadSettings()
      .then((s) => {
        if (disposed) return;
        setTheme(s.theme ?? 'dark');
        applyTheme(s.theme ?? 'dark');
        explainedRef.current = s.individual_explained === true;
      })
      .catch(() => {});
    // A theme chosen in Settings (or any other window) applies here at once.
    const offTheme = subscribeSettingsTheme((next) => {
      setTheme(next);
      applyTheme(next);
    });
    return () => {
      disposed = true;
      off?.();
      offTheme();
    };
  }, []);

  // Warm standby readiness (existing status API).
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const load = () =>
      tauri
        .standbyGetStatus()
        .then((s) => {
          if (disposed || !s) return;
          setReadyAgents(
            new Set(s.standbys.filter((x) => x.state === 'ready' && !x.headless && !x.pane_id).map((x) => x.agent_type)),
          );
        })
        .catch(() => {});
    void load();
    void cockpitApi.onStandbyChanged(() => void load()).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // Prompts: events keep them current; fetch for panes that are waiting and not yet known.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void cockpitApi
      .onPrompt((e) =>
        setPrompts((p) => ({ ...p, [e.pane_id]: e.prompt && p[e.pane_id]?.stalled && p[e.pane_id]?.promptId === e.prompt.promptId ? { ...e.prompt, stalled: true } : e.prompt })),
      )
      .then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  const answered = useRef(new Map<string, number>());
  const justAnswered = (id: string, prompt: PanePrompt | null) => {
    const at = prompt ? answered.current.get(`${id}:${prompt.promptId}`) : undefined;
    return at !== undefined && Date.now() - at < ANSWERED_HOLD_MS;
  };
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const p of paneList) {
      const id = p.info.id;
      if (p.status !== 'waiting_input') {
        requested.current.delete(id);
        continue;
      }
      if (id in prompts || requested.current.has(id)) continue;
      requested.current.add(id);
      cockpitApi
        .panePrompt(id)
        .then((prompt) => setPrompts((cur) => (id in cur ? cur : { ...cur, [id]: justAnswered(id, prompt) ? null : prompt })))
        .catch(() => setPrompts((cur) => (id in cur ? cur : { ...cur, [id]: null })));
    }
    // Drop prompts of panes that stopped waiting or vanished.
    setPrompts((cur) => {
      const keys = Object.keys(cur);
      const stale = keys.filter((k) => panes.get(k)?.status !== 'waiting_input');
      if (!stale.length) return cur;
      const next = { ...cur };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [paneList, panes, prompts]);

  // A pane that still waits but has no card (the first read found nothing, or a redraw cleared it for a moment) is
  // read again until the question is answered or gone from the screen. A card just answered stays gone.
  const promptsNow = useRef(prompts);
  promptsNow.current = prompts;
  const waitingKey = paneList.filter((p) => p.status === 'waiting_input').map((p) => p.info.id).join(',');
  useEffect(() => {
    if (!waitingKey) return;
    const ids = waitingKey.split(',');
    const timer = window.setInterval(() => {
      for (const id of ids) {
        if (promptsNow.current[id]) continue;
        cockpitApi
          .panePrompt(id)
          .then((prompt) => {
            if (!prompt || !prompt.choices?.length) return;
            if (justAnswered(id, prompt)) return;
            setPrompts((cur) => (cur[id] ? cur : { ...cur, [id]: prompt }));
          })
          .catch(() => {});
      }
    }, PROMPT_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [waitingKey]);

  // `?select=<pane id>`: the window was created for a "show this pane" request.
  const initialSelect = useRef(new URLSearchParams(window.location.search).get('select'));
  useEffect(() => {
    const want = initialSelect.current;
    if (!want || !panes.has(want)) return;
    initialSelect.current = null;
    setSelectedId(want);
  }, [panes]);

  // cockpit://select
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void cockpitApi
      .onSelect((e) => {
        setSelectedId(e.pane_id);
        if (spawnRef.current && spawnRef.current.paneId === e.pane_id) setSpawn(null);
      })
      .then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // Spawn stage log for the spawn the user started from this window.
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void cockpitApi
      .onSpawnStage((e) => {
        const cur = spawnRef.current;
        if (!cur || cur.agentId !== e.agent_id) return;
        // Another origin (tray, agent) can emit stages for the same agent: once our spawn is bound
        // to a pane, only that pane's stages count.
        if (cur.paneId && e.pane_id && cur.paneId !== e.pane_id) return;
        const entry = { stage: e.stage, message: e.message, warm: e.warm, at: Date.now() };
        if (e.stage === 'ready') {
          const paneId = e.pane_id ?? cur.paneId;
          setSpawn(null);
          if (paneId) setSelectedId(paneId);
          return;
        }
        setSpawn({
          ...cur,
          paneId: e.pane_id ?? cur.paneId,
          log: [...cur.log, entry],
          failed: e.stage === 'failed' ? (e.message ?? 'Failed to start') : cur.failed,
        });
      })
      .then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  // Every pane this window has seen listed. A selected pane that was listed and is gone was
  // closed (a merge, a discard, Close): the view leaves it at once instead of flashing "Opening
  // pane". A pane that was never listed is still opening and gets the grace period below.
  const everListed = useRef(new Set<string>());
  for (const id of panes.keys()) everListed.current.add(id);
  const shownId = visibleSelection(selectedId, panes, everListed.current, initialReady, !!spawn);
  useEffect(() => {
    if (selectedId && shownId === null) setSelectedId(null);
  }, [selectedId, shownId]);

  // Selected pane never showed up in the list: back to the inbox after a short grace for the refresh.
  useEffect(() => {
    if (!selectedId || !initialReady || panes.has(selectedId) || spawn) return;
    const t = window.setTimeout(() => setSelectedId(null), 1500);
    return () => window.clearTimeout(t);
  }, [selectedId, initialReady, panes, spawn]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setSpawn((s) => (s && !s.failed ? s : null));
  }, []);

  const applyMode = useCallback(
    async (next: UiMode) => {
      const prev = mode;
      // The click's own timestamp (read before any await), so Rust can log click -> first frame.
      const ev = typeof window !== 'undefined' ? (window.event as Event | undefined) : undefined;
      const clickedMsAgo = ev && Number.isFinite(ev.timeStamp) ? Math.max(0, Math.round(performance.now() - ev.timeStamp)) : 0;
      // Individual waits for `ui://mode-changed`: Rust sends it when the animated switch ends, and the tiles must stay
      // mounted until then (the overlay draws from them). Orchestration shows its tiles at once, as before.
      if (next !== 'individual') setModeState(next);
      try {
        await cockpitApi.setUiMode(next, clickedMsAgo);
      } catch (err) {
        setModeState(prev);
        notify(errorSentence(err));
      }
    },
    [mode, notify],
  );

  // A pick from the cockpit (footer, palette): the first switch to Individual explains itself first.
  const setMode = useCallback(
    async (next: UiMode) => {
      if (next === 'individual' && mode !== 'individual' && !explainedRef.current) {
        setExplainerOpen(true);
        return;
      }
      await applyMode(next);
    },
    [mode, applyMode],
  );

  const modeExplainer = useMemo(
    () => ({
      open: explainerOpen,
      confirm: async (dontShowAgain: boolean) => {
        setExplainerOpen(false);
        if (dontShowAgain) {
          explainedRef.current = true;
          patchSettings({ individual_explained: true }).catch(() => {});
        }
        await applyMode('individual');
      },
      cancel: () => setExplainerOpen(false),
    }),
    [explainerOpen, applyMode],
  );

  // A launch that wanted Individual but had no agents opened in Orchestration: say so, and offer the way back.
  const applyModeRef = useRef(applyMode);
  applyModeRef.current = applyMode;
  useEffect(() => {
    let disposed = false;
    cockpitApi
      .takeIndividualFallback()
      .then((fell) => {
        if (fell === true && !disposed) notify('You were in Individual mode', { label: 'Switch back', run: () => void applyModeRef.current('individual') });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [notify]);

  const toggleTheme = useCallback(async () => {
    const next: AppTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    try {
      await patchSettings({ theme: next });
    } catch (err) {
      notify(`Theme not saved: ${errorSentence(err)}`);
    }
  }, [theme, notify]);

  const newAgent = useCallback(
    async (agentId: string, accountId?: string, isolated = false, projectPath?: string, model?: string) => {
      setSelectedId(null);
      setSpawn({ agentId, paneId: null, log: [], failed: null });
      try {
        const paneId = await cockpitApi.newPane(agentId, accountId, isolated ? 'worktree' : undefined, projectPath, model);
        setSpawn((s) => (s && s.agentId === agentId ? { ...s, paneId } : s));
        // The pane may already be attached (ready event raced the command): select it once listed.
        if (spawnRef.current === null) setSelectedId(paneId);
        return paneId;
      } catch (err) {
        setSpawn((s) => (s && s.agentId === agentId ? { ...s, failed: errorSentence(err) } : s));
        return null;
      }
    },
    [],
  );

  // One answer per card: further clicks on the same prompt while the first is on its way (or just
  // landed, before the TUI redrew) send nothing. The backend refuses repeats too
  // (`pane_prompt/answers.rs`); this keeps a double click from even reaching it.
  const answering = useRef(new Set<string>());
  const answer = useCallback(
    async (paneId: string, promptId: string, choiceId: string, label: string, gesture: UserGesture) => {
      const key = `${paneId}\n${promptId}`;
      if (answering.current.has(key)) return;
      answering.current.add(key);
      try {
        await cockpitApi.answerPanePrompt(paneId, promptId, choiceId, gesture);
        answered.current.set(`${paneId}:${promptId}`, Date.now());
        notify(`Answered ${names.get(paneId) ?? 'agent'}: ${label}`);
        window.setTimeout(() => answering.current.delete(key), ANSWER_SETTLE_MS);
        // The key is sent, not proven: if the same question is still drawn, say so and put the card back for a retry.
        window.setTimeout(() => {
          cockpitApi
            .panePrompt(paneId)
            .then((now) => {
              if (!now || now.promptId !== promptId || !now.choices?.length) return;
              answered.current.delete(`${paneId}:${promptId}`);
              answering.current.delete(key);
              setPrompts((cur) => ({ ...cur, [paneId]: { ...now, stalled: true } }));
            })
            .catch(() => {});
        }, ANSWER_CHECK_MS);
      } catch (err) {
        answering.current.delete(key);
        notify(errorSentence(err));
      }
    },
    [names, notify],
  );

  const interrupt = useCallback(
    async (paneId: string) => {
      try {
        await cockpitApi.interruptPane(paneId);
        notify('Sent Ctrl+C');
      } catch (err) {
        notify(errorSentence(err));
      }
    },
    [notify],
  );

  const closePane = useCallback(
    async (paneId: string) => {
      try {
        await registry.killPane(paneId);
        forgetTerminal(paneId);
        setSelectedId((cur) => (cur === paneId ? null : cur));
      } catch (err) {
        notify(errorSentence(err));
      }
    },
    [registry, notify],
  );

  const rename = useCallback(
    async (paneId: string, title: string) => {
      try {
        await cockpitApi.paneSetTitle(paneId, title);
        await registry.refresh();
      } catch (err) {
        notify(errorSentence(err));
      }
    },
    [registry, notify],
  );

  const openSettings = useCallback(async (tab?: string) => {
    try {
      await cockpitApi.openSettings(tab);
    } catch (err) {
      console.error('open_settings failed', err);
      notify(`Settings did not open: ${errorSentence(err)}`);
    }
  }, [notify]);

  const asked = useQuestions(notify, now);

  return {
    asked,
    registry,
    names,
    activities,
    previews,
    launchEntries,
    readyAgents,
    mode,
    theme,
    selectedId: shownId,
    select,
    prompts,
    statusSince,
    now,
    spawn,
    dismissSpawn: () => setSpawn(null),
    chatStarting,
    beginChatStart: chatStarts.begin,
    endChatStart: chatStarts.end,
    toasts,
    notify,
    setMode,
    modeExplainer,
    toggleTheme,
    newAgent,
    answer,
    interrupt,
    closePane,
    rename,
    openSettings,
    bridgeLine,
  };
}
