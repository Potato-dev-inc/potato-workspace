// ONE source for "Check my setup": the Overview cards and the Setup list both read the rows from here, so they can
// never disagree. The provider runs the checks once (and again on `refresh`); a page mounted without a provider
// (a search hit, a test) gets its own copy through the same hook.
//
// The last answer is kept (with its time) so the list is there the moment Settings opens. The checks run again in the
// background only when that answer is older than ten minutes, or when the person presses "Check again". While they
// run, every check reports on its own: fast ones show first, a slow one has a spinner on its row.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getLanguage } from '../../i18n';
import type { CheckGroupId, CheckRow, GroupResult, RunOptions } from '../../lib/setup-checks';
import { errorSentence } from '../../lib/sayError';
import type { SetupCheckActions } from './SetupCheckPage';

export type SetupChecksState = { state: 'loading' } | { state: 'failed'; why: string } | { state: 'ready'; rows: CheckRow[] };

/** One check's rows. `rows: null` is a check that has not answered yet; `busy` is a check being read right now. */
export interface CheckGroupView {
  id: string;
  rows: CheckRow[] | null;
  busy: boolean;
}

export interface SetupChecks {
  result: SetupChecksState;
  /** Runs every check again. The rows stay on screen until the new answers arrive. */
  refresh: () => void;
  /** What the fix buttons do; absent: the page's own defaults. */
  actions?: SetupCheckActions;
  /** When the rows on screen were read (epoch ms); null when nothing has been read yet. */
  checkedAt?: number | null;
  /** The rows by check, in list order, for a list that fills in as the checks finish. */
  groups?: CheckGroupView[];
}

/** The saved answer is used as is up to this age; older, it is shown and read again in the background. */
export const FRESH_MS = 10 * 60 * 1000;
const KEY = 'pm.setupcheck.rows.v1';

interface Saved {
  at: number;
  lang: string;
  groups: { id: string; rows: CheckRow[] }[];
}

/** The saved answer, or null (none, unreadable, or written in another language: the sentences would not match). */
export function loadSavedChecks(): Saved | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Saved | null;
    if (!raw || typeof raw.at !== 'number' || raw.lang !== getLanguage() || !Array.isArray(raw.groups) || raw.groups.length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveChecks(groups: Saved['groups'], at: number): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ at, lang: getLanguage(), groups } satisfies Saved));
  } catch {
    /* storage blocked: the list is just read again next time */
  }
}

const rowsOf = (groups: { rows: CheckRow[] | null }[]): CheckRow[] => groups.flatMap((g) => g.rows ?? []);

const SetupChecksContext = createContext<SetupChecks | null>(null);

/** Runs `run` on mount (unless a fresh saved answer exists) and on every `refresh`. A rejection becomes `failed`; nothing here throws. */
export function useRunSetupChecks(run: (options: RunOptions) => Promise<CheckRow[]>, enabled = true): SetupChecks {
  const [saved] = useState(() => loadSavedChecks());
  const [result, setResult] = useState<SetupChecksState>(() => (saved ? { state: 'ready', rows: rowsOf(saved.groups) } : { state: 'loading' }));
  const [checkedAt, setCheckedAt] = useState<number | null>(saved?.at ?? null);
  const [groups, setGroups] = useState<CheckGroupView[]>(() => (saved ? saved.groups.map((g) => ({ ...g, busy: false })) : []));
  const [tick, setTick] = useState(0);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    if (tick === 0 && saved && Date.now() - saved.at < FRESH_MS) return;
    let alive = true;
    const started = Date.now();
    const arrived = new Map<string, CheckRow[]>();
    const order: string[] = [];
    const before = saved ? new Map(saved.groups.map((g) => [g.id, g.rows])) : new Map<string, CheckRow[]>();
    const draw = () =>
      setGroups(
        order.map((id) => {
          const rows = arrived.get(id) ?? before.get(id) ?? null;
          return { id, rows, busy: !arrived.has(id) };
        }),
      );
    setGroups((g) => g.map((x) => ({ ...x, busy: true })));
    const options: RunOptions = {
      onStart: (ids: CheckGroupId[]) => {
        if (!alive) return;
        order.splice(0, order.length, ...ids);
        draw();
      },
      onGroup: (g: GroupResult) => {
        if (!alive) return;
        arrived.set(g.id, g.rows);
        console.debug(`[setup-check] ${g.id}: ${g.ms} ms${g.timedOut ? ' (did not answer in time)' : ''}`); // i18n-ok: developer log
        draw();
      },
    };
    runRef
      .current(options)
      .then((rows) => {
        if (!alive) return;
        const done: Saved['groups'] = order.length > 0 && order.every((id) => arrived.has(id)) ? order.map((id) => ({ id, rows: arrived.get(id) ?? [] })) : [{ id: 'all', rows }];
        const at = Date.now();
        console.debug(`[setup-check] all: ${at - started} ms`); // i18n-ok: developer log
        setResult({ state: 'ready', rows });
        setCheckedAt(at);
        setGroups(done.map((g) => ({ ...g, busy: false })));
        saveChecks(done, at);
      })
      .catch((error) => {
        if (!alive) return;
        setGroups((g) => g.map((x) => ({ ...x, busy: false })));
        // A saved answer stays on screen when the new read fails; only an empty page says it failed.
        setResult((now) => (now.state === 'ready' ? now : { state: 'failed', why: errorSentence(error) }));
      });
    return () => {
      alive = false;
    };
  }, [tick, enabled, saved]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return useMemo(() => ({ result, refresh, checkedAt, groups }), [result, refresh, checkedAt, groups]);
}

/** `enabled` false: nothing runs and nothing is provided (only the Overview page needs the checks). */
export function SetupChecksProvider({ run, enabled = true, actions, children }: { run: (options: RunOptions) => Promise<CheckRow[]>; enabled?: boolean; actions?: SetupCheckActions; children: ReactNode }) {
  const base = useRunSetupChecks(run, enabled);
  const value = useMemo(() => ({ ...base, actions }), [base, actions]);
  if (!enabled) return <>{children}</>;
  return <SetupChecksContext.Provider value={value}>{children}</SetupChecksContext.Provider>;
}

/** The shared source when a provider is above, else null. */
export function useSharedSetupChecks(): SetupChecks | null {
  return useContext(SetupChecksContext);
}
