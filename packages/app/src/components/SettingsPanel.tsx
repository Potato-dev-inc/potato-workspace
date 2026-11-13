// The Settings window: eight pages (Overview first), row search with synonyms, and the Advanced page. macOS System Settings style.
//
// Nothing here has a Save button. Every control saves itself through `env.patch()`, which sends only the
// keys that control changed (`patchSettings` -> the Rust `settings_patch` command), so this window can
// never write an old copy of the settings over newer values. The window reloads its state whenever the
// settings change anywhere else, and whenever it is shown again (it is hidden, not destroyed, on close).
import { errorSentence } from '../lib/sayError';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '@potato-workspace/shared';
import { findBridgeUrl } from '../lib/bridge';
import { loadSettings, patchSettings, type SettingsPatch } from '../lib/settings';
import { subscribeSettingsRefresh, type SettingsRefreshInfo } from '../lib/settings-sync';
import { resolveSettingsTarget } from '../lib/settings-target';
import { SECTIONS } from './settings/catalog';
import { ConfirmSheet } from './settings/controls';
import { ErrorBoundary } from './common/ErrorBoundary';
import { ClosedGroups, LevelledRows, SectionRows, onRowKeyDown, type RowChrome } from './settings/SectionView';
import { applyPatch, changedRows, resetPatch, sayValue, undoPatch } from './settings/changes';
import { UndoToast, PUT_BACK_MS, type ToastState } from './settings/UndoToast';
import { DEFAULT_OVERVIEW_SOURCES, Overview, setupContext, type OverviewSources } from './settings/Overview';
import { SetupChecksProvider } from './settings/setup-source';
import { setOpenAgent, useOpenAgent } from './settings/agents/agentTarget';
import { useAgentRegistry } from '../lib/agentRegistry';
import { MAX_HITS, limitHits, searchAll } from './settings/search';
import { Btn } from './settings/settings-ui';
import { readAdvancedOpen, writeAdvancedOpen } from './settings/levels';
import {
  findRowSection,
  rowLevel,
  type ConfirmOptions,
  type RowDef,
  type SectionDef,
  type SectionId,
  type SettingsEnv,
  type SettingsPageId,
  visibleSections,
} from './settings/model';
import '../styles/settings.css';
import '../styles/settings-shell.css';
import '../styles/settings-rows.css';
import '../styles/settings-fixes.css';
import { SettingsDamagedBanner } from './settings/SettingsDamagedBanner';

/** What the panel needs from the outside. Tests pass fakes; the app uses the defaults. */
export interface SettingsApi {
  load: () => Promise<Settings>;
  patch: (patch: SettingsPatch) => Promise<Settings>;
  findBridgeUrl: () => Promise<string | null>;
  subscribe: (onRefresh: (info: SettingsRefreshInfo) => void) => () => void;
}

const DEFAULT_API: SettingsApi = {
  load: loadSettings,
  patch: patchSettings,
  findBridgeUrl,
  subscribe: subscribeSettingsRefresh,
};

interface Props {
  open: boolean;
  onClose?: () => void;
  /** Page shown first (the standalone Settings window opens on Overview). */
  initialTab?: SettingsPageId;
  /** A row of that page to scroll to and mark when it opens (a deep link such as `?tab=live-updates`). */
  initialRow?: string;
  /** Called with the page now shown, so a host can carry it to another surface (window <-> inline). */
  onPageChange?: (page: SettingsPageId) => void;
  /** Rendered inside the cockpit's main area (Orchestration) instead of filling a window. */
  inline?: boolean;
  /** Called after any control saved. */
  onSaved?: () => void;
  projectPath?: string | null;
  onProjectPathChange?: (path: string) => Promise<void>;
  /** "Browse more agents" in Settings > Agents. Without it the button is not drawn. */
  onOpenStore?: () => void;
  api?: SettingsApi;
  /** Where the Overview cards read their facts (tests pass fakes). */
  overviewSources?: OverviewSources;
}

const SAVED_TICK_MS = 1600;
/** The remembered open state of one closed group of the Advanced page. */
const groupKey = (group: string) => `advanced:${group}`;
const TARGET_MARK_MS = 2200;
/** A saved key that holds a secret never gets an Undo toast (its value would be shown, or kept in memory). */
const SECRET_KEY = /key|token|secret|password|credential/i;

const IconBack = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 3.5 5.5 8l4.5 4.5" />
  </svg>
);
const IconSearch = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);
const ICON_PROPS = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
/** One small line icon per page, in the same style as the search and back icons. */
const SECTION_ICONS: Record<SectionId, JSX.Element> = {
  overview: (
    <svg {...ICON_PROPS}>
      <rect x="2" y="2.5" width="5" height="5" rx="1.2" />
      <rect x="9" y="2.5" width="5" height="5" rx="1.2" />
      <rect x="2" y="9.5" width="5" height="4" rx="1.2" />
      <rect x="9" y="9.5" width="5" height="4" rx="1.2" />
    </svg>
  ),
  agents: (
    <svg {...ICON_PROPS}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="m5 6.5 2 1.5-2 1.5M8.5 10h2.5" />
    </svg>
  ),
  helpers: (
    <svg {...ICON_PROPS}>
      <circle cx="5.5" cy="5.5" r="2" />
      <circle cx="11" cy="10.5" r="2" />
      <path d="M7 7.2 9.5 9M2.5 13c.3-1.6 1.5-2.6 3-2.6" />
    </svg>
  ),
  look: (
    <svg {...ICON_PROPS}>
      <path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" />
      <circle cx="10" cy="5" r="1.5" />
      <circle cx="6" cy="11" r="1.5" />
    </svg>
  ),
  connect: (
    <svg {...ICON_PROPS}>
      <rect x="4.5" y="2" width="7" height="12" rx="1.8" />
      <path d="M7 11.8h2" />
    </svg>
  ),
  keys: (
    <svg {...ICON_PROPS}>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="m7.3 8.7 6-6M11 5l1.5 1.5" />
    </svg>
  ),
  shortcuts: (
    <svg {...ICON_PROPS}>
      <rect x="1.5" y="4" width="13" height="8" rx="2" />
      <path d="M4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6" />
    </svg>
  ),
  advanced: (
    <svg {...ICON_PROPS}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" />
    </svg>
  ),
};

export function SettingsPanel({
  open,
  onClose,
  initialTab = 'overview',
  initialRow,
  onPageChange,
  inline = false,
  onSaved,
  projectPath = null,
  onProjectPathChange,
  onOpenStore,
  api = DEFAULT_API,
  overviewSources,
}: Props) {
  const [page, setPage] = useState<SettingsPageId>(initialTab);
  const [query, setQuery] = useState('');
  // A row to scroll to once its page is showing. `n` makes asking for the same row twice work.
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(initialRow ? { id: initialRow, n: 0 } : null);
  const [marked, setMarked] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingConfirm, setPendingConfirm] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  // Advanced group state per section, as the person set it this visit (also saved in localStorage).
  const [advancedState, setAdvancedState] = useState<Record<string, boolean>>({});
  // Developer rows are drawn when the setting is on, or when a link or search just opened one of them.
  const [developerRevealed, setDeveloperRevealed] = useState(false);
  // Search: the hit Up/Down has reached (0 = first), and whether "Show all N" was pressed.
  const [activeHit, setActiveHit] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // "Changed" filter: lists only the rows that differ from the default. The Undo toast: one at a time.
  const [showChanged, setShowChanged] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const openAgentId = useOpenAgent();
  const registry = useAgentRegistry();
  const toastSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<Settings | null>(null);
  settingsRef.current = settings;

  const inflight = useRef(0);
  const reloadAfter = useRef(false);
  const tickTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  const reload = useCallback(async () => {
    if (inflight.current > 0) {
      reloadAfter.current = true; // a save is still going out: reload once it lands
      return;
    }
    try {
      const fresh = await apiRef.current.load();
      if (inflight.current === 0) setSettings(fresh);
    } catch {
      /* keep what is shown */
    }
  }, []);

  // Opens the Advanced group (or the developer rows) that holds `rowId`, so a link or deep link can show it.
  const revealRow = useCallback((rowId: string) => {
    const home = findRowSection(SECTIONS, rowId);
    const row = home?.rows.find((r) => r.id === rowId);
    if (!home || !row) return;
    const level = rowLevel(row);
    // On the Advanced page the closed group that holds the row opens; elsewhere it is the page's Advanced fold.
    const key = home.closedGroups ? (row.group && home.closedGroups.includes(row.group) ? groupKey(row.group) : null) : level === 'advanced' ? home.id : null;
    if (key) {
      writeAdvancedOpen(key, true);
      setAdvancedState((prev) => ({ ...prev, [key]: true }));
    }
    if (level === 'developer') setDeveloperRevealed(true);
  }, []);

  useEffect(() => {
    if (initialRow) revealRow(initialRow);
    // Only the row the window opened with; later links go through openRow or the show event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load on open, and again whenever the settings may have changed elsewhere or the window comes back.
  useEffect(() => {
    if (!open) return;
    void reload();
    void apiRef.current.findBridgeUrl().then(setBridgeUrl).catch(() => undefined);
    return apiRef.current.subscribe((info) => {
      void reload();
      if (info.reason === 'show') {
        const target = resolveSettingsTarget(info.tab);
        if (target) {
          setPage(target.page);
          setQuery('');
          if (target.row) revealRow(target.row);
          setFocus(target.row ? { id: target.row, n: Date.now() } : null);
        }
      }
    });
  }, [open, reload, revealRow]);

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [page, query]);

  useEffect(() => {
    setActiveHit(0);
    setShowAll(false);
  }, [query]);

  // Keys: "/" or Ctrl+F focuses the search box; a letter typed while no field has focus starts a search; Escape
  // clears the search first (the host goes back on the second press).
  const queryRef = useRef(query);
  queryRef.current = query;
  const changedFilterRef = useRef(showChanged);
  changedFilterRef.current = showChanged;
  const confirmOpenRef = useRef(false);
  confirmOpenRef.current = pendingConfirm !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || confirmOpenRef.current) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inField = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
      // Keys aimed at something outside this window (the cockpit behind an inline page) are not ours.
      const outside = target !== null && target !== document.body && !target.closest('.settings');
      if (outside) return;
      if (e.key === 'Escape') {
        // Clear the search first, even when focus is on a result. Going back is the host's job (it handles the second press).
        if (queryRef.current && !inField) {
          e.preventDefault();
          setQuery('');
        } else if (changedFilterRef.current && !inField) {
          e.preventDefault();
          setShowChanged(false);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key.length === 1 && e.key !== ' ' && /\S/.test(e.key)) searchRef.current?.focus(); // the letter then lands in the box
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const ready = open && settings !== null && query.trim() === '';
  // Blocks above the target (Team, the Ask bar) fill in a moment after the page opens and push it down, so the
  // scroll is repeated a few times, and stops the moment the person scrolls or types themselves.
  const holdScroll = useRef<(() => void) | null>(null);
  useEffect(() => () => holdScroll.current?.(), []);
  // Scroll to the row a deep link or a "Show" button named, and mark it for a moment.
  useEffect(() => {
    if (!focus || !ready) return;
    const host = scrollRef.current;
    const rows = host?.querySelectorAll<HTMLElement>('[data-row]') ?? [];
    const el = [...rows].find((r) => r.getAttribute('data-row') === focus.id);
    setFocus(null);
    holdScroll.current?.();
    holdScroll.current = null;
    if (!el || !host) return; // the row is not on this page (an old link): stay at the top
    el.scrollIntoView?.({ block: 'center' });
    setMarked(focus.id);
    const timers = [150, 500, 1200].map((ms) => setTimeout(() => el.isConnected && el.scrollIntoView?.({ block: 'center' }), ms));
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const stop = () => {
      timers.forEach(clearTimeout);
      events.forEach((e) => host.removeEventListener(e, stop));
      holdScroll.current = null;
    };
    events.forEach((e) => host.addEventListener(e, stop, { once: true }));
    holdScroll.current = stop;
  }, [focus, ready, page]);
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(null), TARGET_MARK_MS);
    return () => clearTimeout(timer);
  }, [marked]);

  const pageChangeRef = useRef(onPageChange);
  pageChangeRef.current = onPageChange;
  useEffect(() => {
    pageChangeRef.current?.(page);
  }, [page]);

  useEffect(() => {
    const timers = tickTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);

  const markSaved = useCallback((rowId: string) => {
    setSavedIds((prev) => new Set(prev).add(rowId));
    const timers = tickTimers.current;
    const existing = timers.get(rowId);
    if (existing) clearTimeout(existing);
    timers.set(
      rowId,
      setTimeout(() => {
        timers.delete(rowId);
        setSavedIds((prev) => {
          const next = new Set(prev);
          next.delete(rowId);
          return next;
        });
      }, SAVED_TICK_MS),
    );
  }, []);

  const setRowError = useCallback((rowId: string, message: string | null) => {
    setErrors((prev) => {
      if (message === null) {
        if (!(rowId in prev)) return prev;
        const { [rowId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [rowId]: message };
    });
  }, []);

  // Saves one patch for a row: optimistic, then the real write. Rejects on failure (the row shows the error).
  const save = useCallback(
    async (rowId: string, patch: SettingsPatch) => {
      setRowError(rowId, null);
      setSettings((prev) => (prev ? applyPatch(prev, patch) : prev));
      inflight.current += 1;
      try {
        await apiRef.current.patch(patch);
        markSaved(rowId);
        onSaved?.();
      } catch (error) {
        setRowError(rowId, `Not saved: ${errorSentence(error)}`);
        reloadAfter.current = true; // drop the optimistic value and show what is really saved
        throw error; // callers must not run their saved path (clear a draft, show Saved) on failure
      } finally {
        inflight.current -= 1;
        if (inflight.current === 0 && reloadAfter.current) {
          reloadAfter.current = false;
          void reload();
        }
      }
    },
    [markSaved, onSaved, reload, setRowError],
  );

  // After a good save of a row that owns its keys: "Saved. Theme: Light" with Undo (5 s). Never for danger rows,
  // rows without keys, or anything that holds a secret. A failed save never gets here.
  const offerUndo = useCallback(
    (rowId: string, patch: SettingsPatch, before: Settings | null, reset: boolean) => {
      const row = findRowSection(SECTIONS, rowId)?.rows.find((r) => r.id === rowId);
      const patched = Object.keys(patch);
      if (!row?.keys || row.danger || !before || !patched.some((k) => (row.keys as string[]).includes(k)) || patched.some((k) => SECRET_KEY.test(k))) return;
      const text = `${reset ? 'Reset' : 'Saved'}. ${sayValue(row, applyPatch(before, patch))}`;
      const back = undoPatch(before, patch);
      setToast({ id: ++toastSeq.current, text, undo: () => save(rowId, back) });
    },
    [save],
  );

  const patchFor = useCallback(
    async (rowId: string, patch: SettingsPatch, reset = false) => {
      const before = settingsRef.current;
      await save(rowId, patch);
      offerUndo(rowId, patch, before, reset);
    },
    [offerUndo, save],
  );

  const runUndo = useCallback(async (t: ToastState) => {
    if (!t.undo) return;
    setToast(null);
    try {
      await t.undo();
      setToast({ id: ++toastSeq.current, text: 'Put back.', ms: PUT_BACK_MS });
    } catch {
      /* save() already put the error on the row */
    }
  }, []);

  const resetRow = (row: RowDef) => {
    patchFor(row.id, resetPatch(row), true).catch(() => undefined);
  };

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPendingConfirm({ options, resolve })),
    [],
  );
  const settle = (ok: boolean) => {
    pendingConfirm?.resolve(ok);
    setPendingConfirm(null);
  };

  const openRow = (rowId: string) => {
    const home = findRowSection(SECTIONS, rowId);
    if (!home) return;
    revealRow(rowId);
    setPage(home.id);
    setQuery('');
    setShowChanged(false);
    setFocus({ id: rowId, n: Date.now() });
  };

  const envFor = (row: RowDef): SettingsEnv => ({
    settings: settings as Settings,
    openRow,
    openStore: onOpenStore,
    patch: (patch) => {
      const done = patchFor(row.id, patch);
      done.catch(() => undefined); // the panel already shows the error; fire-and-forget callers stay quiet
      return done;
    },
    markSaved: () => markSaved(row.id),
    setError: (message) => setRowError(row.id, message),
    confirm,
    projectPath,
    onProjectPathChange,
    bridgeUrl,
  });

  if (!open) return null;

  // The Advanced fold is open when the person opened it (remembered), or by default when the page has no basic rows.
  const advancedOpenFor = (s: SectionDef) => advancedState[s.id] ?? readAdvancedOpen(s.id) ?? !s.rows.some((r) => rowLevel(r) === 'basic');
  const toggleAdvanced = (s: SectionDef) => {
    const next = !advancedOpenFor(s);
    writeAdvancedOpen(s.id, next);
    setAdvancedState((prev) => ({ ...prev, [s.id]: next }));
  };
  // The Advanced page: each closed group is remembered by itself, closed until opened.
  const groupOpen = (group: string) => advancedState[groupKey(group)] ?? readAdvancedOpen(groupKey(group)) ?? false;
  const toggleGroup = (group: string) => {
    const next = !groupOpen(group);
    writeAdvancedOpen(groupKey(group), next);
    setAdvancedState((prev) => ({ ...prev, [groupKey(group)]: next }));
  };

  const trimmed = query.trim();
  const shown = visibleSections(SECTIONS, settings);
  const result = trimmed ? searchAll(shown, trimmed) : null;
  const visibleHits = result ? (showAll ? result.hits : limitHits(result.hits, MAX_HITS)) : [];
  // Everything Up/Down can reach: "Go to page" hits first, then the rows, in the order they are drawn.
  const items: ({ kind: 'page'; page: SectionId } | { kind: 'row'; id: string })[] = [
    ...(result?.names ?? []).map((n) => ({ kind: 'page' as const, page: n.page.id })),
    ...visibleHits.flatMap((h) => h.rows.map((r) => ({ kind: 'row' as const, id: r.id }))),
  ];
  const activeItem = items[Math.min(activeHit, Math.max(items.length - 1, 0))];
  const goToPage = (id: SectionId) => {
    setOpenAgent(null); // a page button always lands on the page's top, not inside an agent
    setPage(id);
    setQuery('');
    setFocus(null);
    setShowChanged(false);
  };
  const openItem = (item: (typeof items)[number] | undefined) => {
    if (!item) return;
    if (item.kind === 'page') goToPage(item.page);
    else openRow(item.id);
  };
  // A page of a feature that is switched off (the link was kept, or the switch just moved) shows the first page instead.
  const section = shown.find((s) => s.id === page) ?? (settings ? shown[0] : undefined);
  const chrome: RowChrome = { saved: savedIds, errors, target: marked ?? undefined, active: activeItem?.kind === 'row' ? activeItem.id : undefined, onReset: resetRow };
  const changed = changedRows(shown, settings);
  const changedCount = changed.reduce((n, hit) => n + hit.rows.length, 0);
  const changedPages = new Set(changed.map((hit) => hit.section.id));
  const filtering = showChanged && !trimmed;
  const showChangedRows = () => {
    setQuery('');
    setFocus(null);
    setShowChanged(true);
  };
  const showDeveloper = Boolean(settings?.show_developer_settings) || developerRevealed;

  // With an agent's page open, the window shows only that page, and the title reads "Agents › Claude".
  const openAgent = !trimmed && !filtering && section?.id === 'agents' ? openAgentId : null;
  const openAgentLabel = openAgent ? (registry.agents.find((a) => a.id === openAgent)?.label ?? openAgent) : null;
  const title = trimmed ? 'Search results' : filtering ? 'Changed' : (section?.title ?? 'Settings');
  const blurb = trimmed
    ? result && result.total + result.names.length > 0
      ? `${result.total} ${result.total === 1 ? 'setting' : 'settings'} for “${trimmed}”. Up and Down to move, Enter to open.`
      : undefined
    : filtering
      ? changedCount > 0
        ? `${changedCount} ${changedCount === 1 ? 'setting' : 'settings'} you changed.`
        : undefined
      : section?.blurb;

  return (
    <div className={inline ? 'settings settings--inline' : 'settings'} role="region" aria-label="Settings">
      <aside className="st-side">
        <div className="st-side-top">
          {onClose && (
            <button type="button" className="st-back" aria-label={inline ? 'Back' : 'Close settings'} onClick={onClose}>
              <IconBack />
            </button>
          )}
          <label className="st-search">
            <IconSearch />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search settings"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery('');
                  }
                } else if (e.key === 'ArrowDown' && items.length > 0) {
                  e.preventDefault();
                  setActiveHit((i) => Math.min(i + 1, items.length - 1));
                } else if (e.key === 'ArrowUp' && items.length > 0) {
                  e.preventDefault();
                  setActiveHit((i) => Math.max(i - 1, 0));
                } else if (e.key === 'Enter' && trimmed) {
                  e.preventDefault();
                  openItem(activeItem);
                }
              }}
            />
            {!query && (
              <span className="st-kbd" aria-hidden="true">
                /
              </span>
            )}
          </label>
        </div>
        {/* The row is always reserved, so the nav does not jump when the first change appears. */}
        <div className="st-chip-slot">
          {(changedCount > 0 || filtering) && (
            <button
              type="button"
              className="st-chip"
              aria-pressed={filtering}
              onClick={() => (filtering ? setShowChanged(false) : showChangedRows())}
            >
              {`Changed (${changedCount})`}
            </button>
          )}
        </div>
        <nav className="st-nav" aria-label="Settings pages">
          {shown.map((item) => (
            <Fragment key={item.id}>
              {item.id === 'advanced' && <div className="st-navsep" role="separator" />}
              <button
                type="button"
                className="st-nav-row"
                aria-current={!trimmed && !filtering && section?.id === item.id ? 'page' : undefined}
                onClick={() => goToPage(item.id)}
              >
                {SECTION_ICONS[item.id]}
                <span>{item.title}</span>
                {changedPages.has(item.id) && <i className="st-nav-dot" role="img" title="Changed from the default" aria-label="Has a changed setting" />}
              </button>
            </Fragment>
          ))}
        </nav>
      </aside>

      <main className="st-main">
        <header className="st-title" data-scrolled={scrolled ? 'true' : undefined}>
          <h1>
            {openAgentLabel ? (
              <>
                <button type="button" className="st-title-link" aria-label="Back to all agents" onClick={() => setOpenAgent(null)}>
                  {title}
                </button>
                {' › '}
                {openAgentLabel}
              </>
            ) : (
              title
            )}
          </h1>
          {blurb && <p>{blurb}</p>}
          {filtering && changedCount > 0 && (
            <button type="button" className="st-linkbtn st-reset-all" onClick={() => changed.forEach((hit) => hit.rows.forEach(resetRow))}>
              Reset all
            </button>
          )}
        </header>
        <div className="st-scroll" ref={scrollRef} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          <div className="st-page" onKeyDown={onRowKeyDown}>
            <SettingsDamagedBanner />
            {trimmed ? (
              settings === null ? (
                <Skeleton />
              ) : result && result.hits.length === 0 && result.names.length === 0 ? (
                <>
                  <div className="st-emptycard">
                    <p>
                      <b>{`Nothing found for "${trimmed}"`}</b>
                    </p>
                    <p className="st-empty-help">{'Try a simpler word, like "theme", "phone" or "sign in".'}</p>
                    <Btn primary onClick={() => setQuery('')}>
                      Clear search
                    </Btn>
                  </div>
                  <p className="st-quiet-links">
                    <button type="button" className="st-linkbtn" onClick={() => openRow('setup-check')}>
                      Check my setup
                    </button>
                    {' · '}
                    <button type="button" className="st-linkbtn" onClick={showChangedRows}>
                      Show what I changed
                    </button>
                    {' · '}
                    <button type="button" className="st-linkbtn" onClick={() => goToPage('advanced')}>
                      Advanced
                    </button>
                  </p>
                </>
              ) : (
                <div className="st-results">
                  {result && result.names.length > 0 && (
                    <div className="st-names">
                      {result.names.map((n) => (
                        <button
                          key={`${n.page.id}:${n.group ?? ''}`}
                          type="button"
                          className="st-name-hit"
                          data-active={activeItem?.kind === 'page' && activeItem.page === n.page.id && !n.group ? 'true' : undefined}
                          onClick={() => goToPage(n.page.id)}
                        >
                          <span>{n.group ? `${n.page.title} › ${n.group}` : n.page.title}</span>
                          <small>Go to page</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {visibleHits.map(({ section: hitSection, rows }) => (
                    <section key={hitSection.id} data-section={hitSection.id}>
                      <SectionRows rows={rows} envFor={envFor} chrome={chrome} pathPrefix={hitSection.title} onGoToRow={openRow} />
                    </section>
                  ))}
                  {result && !showAll && result.total > MAX_HITS && (
                    <Btn className="st-showall" onClick={() => setShowAll(true)}>
                      {`Show all ${result.total}`}
                    </Btn>
                  )}
                </div>
              )
            ) : settings === null ? (
              <Skeleton />
            ) : filtering ? (
              changed.length === 0 ? (
                <div className="st-emptycard">
                  <p>
                    <b>Nothing changed. Everything is as it came.</b>
                  </p>
                  <Btn primary onClick={() => setShowChanged(false)}>
                    Show all settings
                  </Btn>
                </div>
              ) : (
                <div className="st-results">
                  {changed.map(({ section: hitSection, rows }) => (
                    <section key={hitSection.id} data-section={hitSection.id}>
                      <SectionRows rows={rows} envFor={envFor} chrome={chrome} pathPrefix={hitSection.title} />
                    </section>
                  ))}
                </div>
              )
            ) : (
              section && (
                <SetupChecksProvider enabled={section.id === 'overview'} actions={(overviewSources ?? DEFAULT_OVERVIEW_SOURCES).actions} run={() => (overviewSources ?? DEFAULT_OVERVIEW_SOURCES).checks((overviewSources ?? DEFAULT_OVERVIEW_SOURCES).setupDeps, setupContext(settings, bridgeUrl))}>
                <ErrorBoundary where="Settings page" resetKeys={[section.id]}>
                  {section.id === 'overview' && (
                    <Overview settings={settings} bridgeUrl={bridgeUrl} openRow={openRow} openPage={goToPage} sources={overviewSources} />
                  )}
                  {section.closedGroups ? (
                    <ClosedGroups
                      key={section.id}
                      rows={section.rows}
                      closed={section.closedGroups}
                      envFor={envFor}
                      chrome={chrome}
                      isOpen={groupOpen}
                      onToggle={toggleGroup}
                      showDeveloper={showDeveloper}
                    />
                  ) : (
                    <LevelledRows
                      key={section.id}
                      rows={openAgent ? section.rows.filter((r) => r.id === 'agent-list').map((r) => ({ ...r, group: undefined })) : section.rows}
                      envFor={envFor}
                      chrome={chrome}
                      advancedOpen={advancedOpenFor(section)}
                      onToggleAdvanced={() => toggleAdvanced(section)}
                      showDeveloper={showDeveloper}
                      flat={section.id === 'shortcuts'}
                    />
                  )}
                  {section.id === 'overview' && changedCount > 0 && (
                    <p className="st-quiet-line">
                      {`You changed ${changedCount} ${changedCount === 1 ? 'setting' : 'settings'}. `}
                      <button type="button" className="st-linkbtn" onClick={showChangedRows}>
                        Show them
                      </button>
                    </p>
                  )}
                </ErrorBoundary>
                </SetupChecksProvider>
              )
            )}
          </div>
        </div>
        {toast && <div className="st-toast-host">
          <UndoToast key={toast.id} toast={toast} onDone={(id) => setToast((t) => (t?.id === id ? null : t))} onUndo={(t) => void runUndo(t)} />
        </div>}
      </main>

      {pendingConfirm && (
        <ConfirmSheet
          title={pendingConfirm.options.title}
          body={pendingConfirm.options.body}
          confirmLabel={pendingConfirm.options.confirmLabel}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="st-list" aria-busy="true" aria-label="Loading settings">
      {[0, 1, 2].map((n) => (
        <div key={n} className="st-skel">
          <span style={{ width: 120 + n * 28 }} />
          <span style={{ width: 52 }} />
        </div>
      ))}
    </div>
  );
}
