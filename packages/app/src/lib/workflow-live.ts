// The live view of a running workflow (Labs "Workflows"): which helper stands in which box of the crew, one state word and a
// timer for each, and a short log of who started and who finished. Built on the same live pane data as the crew chip
// (parent and child links, started_as, status). Pure model first, then the small hooks the canvas uses. No new backend.
import { useEffect, useRef, useState } from 'react';
import { t as translate } from '../i18n';
import type { Crew, CrewRole } from './crews-api';
import { DEFAULT_AGENT } from './crews-api';
import { crewMembers, type CrewMember, type CrewState } from './crew-chip';
import { crewOf } from './crew-members';
import { cockpitApi } from './cockpit-api';
import { loadSettings } from './settings';
import { tauri, type PaneInfo } from './tauri';
import { formatElapsed } from '../components/cockpit/model';
import { frontOf, isCalled, keyOf } from '../components/crews/model';

type Tr = typeof translate;

/** The pane data the live view reads (the same shape the crew chip reads). */
export interface LivePane {
  info: PaneInfo;
  status: string;
}

export interface LiveHelper extends CrewMember {
  /** The box this helper stands in (a role key), or null when no box fits. */
  roleKey: string | null;
  /** The name the log uses: the box's name, else the agent's. */
  who: string;
}

/** What one box shows: the most pressing helper in it. */
export interface RoleLive {
  state: CrewState;
  startedAt: number;
  helperId: string;
  /** How many helpers stand in this box. */
  count: number;
  /** When the helper was seen to finish (ms), if this view saw it. */
  endedAt?: number;
}

const ORDER: Record<CrewState, number> = { 'needs-you': 0, failed: 1, working: 2, done: 3 };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole words only: "Test" is not found in "Tester". */
const hasWord = (text: string, word: string): boolean => !!word.trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word.trim())}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * The box a helper belongs to. Among the boxes of its agent (a box with no set agent fits any agent, but only when no box of its own
 * agent does): the box whose whole-word name the title or task carries (the longest name wins), else a box nobody stands in yet
 * (`used`), else the first.
 */
export function roleOfHelper(crew: Crew, member: CrewMember, task: string | null | undefined, used: ReadonlySet<string> = new Set()): CrewRole | null {
  const helpers = crew.roles.filter((r) => !r.front);
  const typed = helpers.filter((r) => r.agent_type !== DEFAULT_AGENT && (!member.agentType || r.agent_type === member.agentType));
  const pool = typed.length ? typed : helpers.filter((r) => r.agent_type === DEFAULT_AGENT);
  if (pool.length === 0) return null;
  const text = `${member.title} ${task ?? ''}`;
  const named = pool.filter((r) => hasWord(text, r.name)).sort((x, y) => y.name.length - x.name.length)[0];
  return named ?? pool.find((r) => !used.has(keyOf(r))) ?? pool[0] ?? null;
}

/** The helpers the front chat started, each with its box. */
export function liveHelpers(crew: Crew, panes: ReadonlyArray<LivePane>, frontId: string, agentNameOf: (p: LivePane) => string, asking?: ReadonlySet<string>): LiveHelper[] {
  const used = new Set<string>();
  return crewMembers(panes, frontId, agentNameOf, asking)
    .sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
    .map((m) => {
      const pane = panes.find((p) => p.info.id === m.id);
      const role = roleOfHelper(crew, m, pane?.info.origin?.task, used);
      if (role) used.add(keyOf(role));
      return { ...m, roleKey: role ? keyOf(role) : null, who: role?.name ?? agentNameOf(pane ?? { info: { id: m.id } as PaneInfo, status: '' }) };
    });
}

/** Per box: the most pressing helper (needs you, failed, working, done), the newest on a tie. */
export function roleStates(helpers: ReadonlyArray<LiveHelper>, endedAt?: ReadonlyMap<string, number>): Map<string, RoleLive> {
  const out = new Map<string, RoleLive>();
  for (const h of helpers) {
    if (!h.roleKey) continue;
    const before = out.get(h.roleKey);
    const count = (before?.count ?? 0) + 1;
    if (!before || ORDER[h.state] < ORDER[before.state] || (ORDER[h.state] === ORDER[before.state] && h.startedAt > before.startedAt)) {
      out.set(h.roleKey, { state: h.state, startedAt: h.startedAt, helperId: h.id, count, endedAt: endedAt?.get(h.id) });
    } else {
      out.set(h.roleKey, { ...before, count });
    }
  }
  return out;
}

/** The one-line summary the chat shows ("2 helpers working, 1 needs you"), or null while nothing runs or waits. */
export function workflowStatus(helpers: ReadonlyArray<LiveHelper>, t: Tr = translate): string | null {
  const w = helpers.filter((h) => h.state === 'working').length;
  const n = helpers.filter((h) => h.state === 'needs-you').length;
  const f = helpers.filter((h) => h.state === 'failed').length;
  const parts: string[] = [];
  if (w) parts.push(t('crewcanvas.live.n.working', { count: w }));
  if (n) parts.push(t('crewcanvas.live.n.needYou', { count: n }));
  if (f) parts.push(t('crewcanvas.live.n.failed', { count: f }));
  return parts.length ? parts.join(', ') : null;
}

export type LiveEventKind = 'started' | 'finished' | 'needs-you' | 'failed';

export interface LiveEvent {
  key: string;
  at: number;
  kind: LiveEventKind;
  helperId: string;
  roleKey: string | null;
  who: string;
  what: string;
  /** How long it worked, for a finish this view saw begin. */
  took?: number;
}

export type Seen = Map<string, { state: CrewState; startedAt: number }>;

export function seenOf(helpers: ReadonlyArray<LiveHelper>): Seen {
  return new Map(helpers.map((h) => [h.id, { state: h.state, startedAt: h.startedAt }] as const));
}

/**
 * What changed since `prev`. The first look (`prev` null) tells how each helper began, and how it stands if it is not working;
 * it never counts as news (the caller draws no dots for it).
 */
export function diffLive(prev: Seen | null, next: ReadonlyArray<LiveHelper>, now: number): LiveEvent[] {
  const out: LiveEvent[] = [];
  const base = (h: LiveHelper, kind: LiveEventKind, at: number, extra?: Partial<LiveEvent>): LiveEvent => ({ key: `${h.id}:${kind}:${at}`, at, kind, helperId: h.id, roleKey: h.roleKey, who: h.who, what: h.title, ...extra });
  const state = (h: LiveHelper, before: CrewState | null) => {
    if (h.state === before) return;
    if (h.state === 'done') out.push(base(h, 'finished', now, prev && (before === 'working' || before === 'needs-you') ? { took: Math.max(0, now - h.startedAt) } : undefined));
    else if (h.state === 'needs-you') out.push(base(h, 'needs-you', now));
    else if (h.state === 'failed') out.push(base(h, 'failed', now));
  };
  for (const h of next) {
    const before = prev?.get(h.id);
    if (!before) {
      out.push(base(h, 'started', h.startedAt));
      state(h, 'working');
    } else state(h, before.state);
  }
  return out.sort((a, b) => a.at - b.at);
}

export function eventText(e: LiveEvent, t: Tr = translate): string {
  if (e.kind === 'started') return t('crewcanvas.live.log.started', { who: e.who, what: e.what });
  if (e.kind === 'finished') return e.took !== undefined ? t('crewcanvas.live.log.finishedIn', { who: e.who, took: formatElapsed(e.took) }) : t('crewcanvas.live.log.finished', { who: e.who });
  return t(e.kind === 'needs-you' ? 'crewcanvas.live.log.needsYou' : 'crewcanvas.live.log.failed', { who: e.who });
}

/** The one word a box shows. */
export const liveWord = (state: CrewState, t: Tr = translate): string =>
  t(state === 'needs-you' ? 'crewcanvas.live.state.needsYou' : state === 'failed' ? 'crewcanvas.live.state.failed' : state === 'working' ? 'crewcanvas.live.state.working' : 'crewcanvas.live.state.done');

export const LOG_LINES = 4;
export const DOT_MS = 1400;
export const PULSE_MS = 900;

export const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export interface LiveDot {
  key: string;
  roleKey: string;
  /** down: the front started the helper; up: the helper reported back. */
  dir: 'down' | 'up';
}

export interface LiveFeed {
  log: LiveEvent[];
  dots: LiveDot[];
  /** Boxes whose arrow is lit for a moment (reduced motion: instead of a dot). */
  pulse: ReadonlySet<string>;
  endedAt: ReadonlyMap<string, number>;
}

/** Follows the helpers: keeps the log, and turns each start and each finish into one dot (or, with reduced motion, one brief highlight). */
export function useLiveFeed(helpers: ReadonlyArray<LiveHelper>, active: boolean, now: () => number = Date.now): LiveFeed {
  const seen = useRef<Seen | null>(null);
  const [log, setLog] = useState<LiveEvent[]>([]);
  const [dots, setDots] = useState<LiveDot[]>([]);
  const [pulse, setPulse] = useState<ReadonlySet<string>>(new Set());
  const [endedAt, setEnded] = useState<ReadonlyMap<string, number>>(new Map());
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(
    () => () => {
      for (const id of timers.current) clearTimeout(id);
      timers.current = [];
    },
    [],
  );
  /** A timer that forgets itself when it has run. */
  const after = (ms: number, run: () => void) => {
    const id = setTimeout(() => {
      timers.current = timers.current.filter((x) => x !== id);
      run();
    }, ms);
    timers.current.push(id);
  };
  useEffect(() => {
    if (!active) return;
    const first = seen.current === null;
    const stamp = now();
    const news = diffLive(seen.current, helpers, stamp);
    seen.current = seenOf(helpers);
    if (news.length === 0) return;
    setLog((before) => [...before, ...news].slice(-40));
    const done = news.filter((e) => e.kind === 'finished' && !first);
    if (done.length) setEnded((before) => new Map([...before, ...done.map((e) => [e.helperId, e.at] as const)]));
    if (first) return;
    // At most one dot (or highlight) per box in one batch.
    const seenBox = new Set<string>();
    const moves = news.filter((e) => {
      if ((e.kind !== 'started' && e.kind !== 'finished') || !e.roleKey || seenBox.has(e.roleKey)) return false;
      seenBox.add(e.roleKey);
      return true;
    });
    if (moves.length === 0) return;
    if (reducedMotion()) {
      const keys = moves.map((e) => e.roleKey!);
      setPulse((before) => new Set([...before, ...keys]));
      after(PULSE_MS, () => setPulse((before) => new Set([...before].filter((k) => !keys.includes(k)))));
      return;
    }
    const fresh = moves.map((e): LiveDot => ({ key: e.key, roleKey: e.roleKey!, dir: e.kind === 'started' ? 'down' : 'up' }));
    setDots((before) => [...before, ...fresh]);
    after(DOT_MS, () => setDots((before) => before.filter((d) => !fresh.some((f) => f.key === d.key))));
  }, [helpers, active, now]);
  return { log, dots, pulse, endedAt };
}

/** A clock that ticks each second while `on`. */
export function useNow(on: boolean): number {
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setAt(Date.now());
    const id = setInterval(() => setAt(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return at;
}

/** Labs "Workflows" on? (read from the saved settings). */
export function useWorkflowsEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    void loadSettings().then(
      (s) => {
        if (live) setOn((s as { workflows_enabled?: boolean }).workflows_enabled === true);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return on;
}

export const READ_BATCH_MS = 150;

/** Every pane and the chats with a question waiting, read again (batched) whenever the app says panes or statuses changed. Off: nothing is read. */
export function useLivePanes(enabled: boolean): { panes: LivePane[]; asking: ReadonlySet<string> } {
  const [list, setList] = useState<LivePane[]>([]);
  const [asking, setAsking] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    let seq = 0;
    let wait: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      const mine = ++seq;
      tauri.listPanes().then(
        (panes) => live && mine === seq && setList(panes.map((info) => ({ info, status: info.status }))),
        () => undefined,
      );
      cockpitApi.questionsList().then(
        (qs) => live && mine === seq && setAsking(new Set(qs.map((q) => q.pane_id).filter((id): id is string => !!id))),
        () => undefined,
      );
    };
    const soon = () => {
      if (wait) return;
      wait = setTimeout(() => {
        wait = null;
        read();
      }, READ_BATCH_MS);
    };
    read();
    const offs: Array<() => void> = [];
    for (const sub of [tauri.onPanesChanged, tauri.onPtyStatus]) {
      sub(soon).then(
        (off) => (live ? offs.push(off) : off()),
        () => undefined,
      );
    }
    return () => {
      live = false;
      if (wait) clearTimeout(wait);
      for (const off of offs) off();
    };
  }, [enabled]);
  return { panes: list, asking };
}

/** The chat that was started as this crew's Front (the newest, when it was started more than once), or null. */
export function frontPaneOf(crew: Crew, slug: string, panes: ReadonlyArray<LivePane>): LivePane | null {
  const front = frontOf(crew);
  if (!front) return null;
  const mine = panes.filter((p) => {
    const m = crewOf(p.info.id);
    return !!m && m.slug === slug && isCalled(front, m.role);
  });
  return mine.sort((a, b) => b.info.created_at - a.info.created_at)[0] ?? null;
}

