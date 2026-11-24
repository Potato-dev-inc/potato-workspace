import type { PaneInfo } from '@potato-workspace/shared';
import { pcModeOf, pcNameOf, type PcMode, type PcSession } from '../../lib/runtime/pclink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { devicesApi, remoteId, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient, subscribeRemote } from '../../lib/runtime/remote';
import { pollWithBackoff } from '../../lib/runtime/pollWithBackoff';
import { deviceLocation, type ProjectLocation } from '../../lib/projectLocation';
import { useDevices } from './useDevices';
import { farQuestionsOf, type FarQuestion } from '../../lib/runtime/farQuestions';
import { beatTargets, FAR_BEAT_MS, quietNodes } from '../../lib/runtime/farBeat';

/** How often each online device's pane list is read again when no event came. */
export const GROUP_POLL_MS = 15_000;

/** One pane or chat of another device, as this PC lists it. Texts come from the other device: show them as text only. */
export interface RemoteRow {
  /** `dev:<node>:<pane id>`: nothing local can look like it. */
  key: string;
  node: string;
  paneId: string;
  title: string;
  agent: string;
  status: PaneInfo['status'];
  /** The folder's name on that PC (never its path). */
  cwd: string;
  /** The folder's opaque id on that PC: what groups the rows. */
  project: string;
  /** A chat session (no terminal behind it). */
  chat: boolean;
  /** The pane that started this one (a minion or a helper sits under it, like on this PC), if the far PC says. */
  parent?: string;
  /** `minion` | `spin_off`, as this PC's own panes carry it. */
  startedAs?: 'minion' | 'spin_off';
  /** A standby's own chat: not an agent row (hidden here as on its own PC). */
  standby?: boolean;
  /** It works on a separate copy of its project. */
  copy?: boolean;
  /** Its number among its agent's chats on its own PC, and how many there are: the far PC names it, this PC never renumbers. */
  nameN?: number;
  nameOf?: number;
  /** The workflow mark the far PC gives this chat (its own, not a mark of this PC's browser storage). */
  workflow?: PcSession['workflow'];
  /** What the far PC says about the chat (a newer far PC only): its git branch name, model name and permission mode. */
  branch?: string;
  model?: string;
  mode?: PcMode;
  /** Where this row lives: that device. */
  location: ProjectLocation;
  /** The chat was in the list, the PC went away, and it is not there now (the app there restarted): this PC keeps its last-known look until the person closes it. */
  ended?: boolean;
}

export interface DeviceGroup {
  device: Device;
  rows: RemoteRow[];
}

export interface DeviceGroups {
  view: DevicesView | null;
  /** The Labs switch, as the backend reports it. */
  enabled: boolean;
  groups: DeviceGroup[];
  /** What the online PCs wait on (their questions and approvals), when this PC may answer them (Answer or Full there). Never a PC that is away. */
  questions: FarQuestion[];
  /** The online PCs whose session list was read since they came online: only then does a missing session mean it is gone. */
  listed: ReadonlySet<string>;
  /** The same plus the ones dismissed from the Inbox: the chat they belong to still draws them (the far agent still waits). */
  allQuestions: FarQuestion[];
  /** Sends the answer to the far PC, which settles the card there; this PC's list is read again. Rejects with the far PC's refusal. */
  answerQuestion: (key: string, answer: { choice_id?: string; text?: string }) => Promise<void>;
  /** Hides one far card on this PC until the far PC drops it (the far PC still waits). */
  hideQuestion: (key: string) => void;
  refresh: () => void;
  /** Drops a chat that ended while its PC was off (the person closed it). */
  forget: (key: string) => void;
  /** The PC whose chat is open on screen (or null): it is checked for answers even while its chats are idle. */
  watch: (node: string | null) => void;
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '');

/** The session that started this one: `helper_of` (a newer far PC), else `parent`. */
const parentOf = (p: PcSession): string => clip(p.helper_of ?? p.parent, 200);

export function rowOf(node: string, p: PcSession, name = ''): RemoteRow {
  // A device only serves its own local sessions: an id that already names a device is never listed.
  return {
    key: remoteId(node, p.id),
    node,
    paneId: p.id,
    // No title: the row is called by its agent's name, numbered like the rows of that PC (`paneNames`), never by the raw agent id.
    title: clip(p.title, 80),
    agent: clip(p.agent, 40),
    status: p.status as PaneInfo['status'],
    cwd: clip(p.folder, 120),
    project: clip(p.project, 40),
    chat: p.chat === true || p.lane === 'acp',
    location: deviceLocation(node, name),
    ...(parentOf(p) ? { parent: parentOf(p) } : {}),
    ...(p.started_as === 'minion' || p.started_as === 'spin_off' ? { startedAs: p.started_as } : {}),
    ...(p.standby === true ? { standby: true } : {}),
    ...(p.copy === true ? { copy: true } : {}),
    ...(Number.isInteger(p.agent_n) && Number.isInteger(p.agent_of) && p.agent_n! > 0 && p.agent_of! > 0 ? { nameN: p.agent_n, nameOf: p.agent_of } : {}),
    ...(p.workflow && typeof p.workflow.slug === 'string' ? { workflow: { slug: clip(p.workflow.slug, 80), role: clip(p.workflow.role, 80), front: p.workflow.front === true, ...(clip(p.workflow.name, 80) ? { name: clip(p.workflow.name, 80) } : {}) } } : {}),
    ...(pcNameOf(p.branch) ? { branch: pcNameOf(p.branch) } : {}),
    ...(pcNameOf(p.model) ? { model: pcNameOf(p.model) } : {}),
    ...(pcModeOf(p.mode) ? { mode: pcModeOf(p.mode) } : {}),
  };
}

/**
 * The sidebar groups: one per paired device that has something to show. An online device is read through the link and
 * kept current by its event stream; one that goes offline keeps the rows it last had, greyed (nothing lived on this
 * side, so nothing is lost). A device that does not let this PC in has a group with only its header.
 */
export function useDeviceGroups(api: DevicesApi = devicesApi): DeviceGroups {
  const { view, enabled, refresh } = useDevices(api);
  const [rows, setRows] = useState<Record<string, RemoteRow[]>>({});
  const online = useMemo(() => (view?.devices ?? []).filter((d) => d.state === 'online').map((d) => d.node), [view]);
  const onlineKey = online.join('|');
  const alive = useRef(true);
  // What each online PC waits on, read with the sessions (by its `questions` frame and the same poll). Seen-at times are this PC's own clock.
  const [asked, setAsked] = useState<Record<string, FarQuestion[]>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [listed, setListed] = useState<ReadonlySet<string>>(new Set());
  const seenAt = useRef(new Map<string, number>());
  // PCs that were away since their list was last read: what is missing after they come back ended there, instead of being closed here.
  const awayNodes = useRef(new Set<string>());
  // When each PC last answered anything (a list, a card, an event, the small check below): a busy chat on a PC that stopped answering shows Away.
  const beats = useRef(new Map<string, number>());
  const beat = useCallback((node: string) => void beats.current.set(node, Date.now()), []);
  const [quiet, setQuiet] = useState<ReadonlySet<string>>(new Set());
  const [watched, watch] = useState<string | null>(null);
  const nameOf = useRef((node: string) => node);
  nameOf.current = (node: string) => view?.devices.find((d) => d.node === node)?.name ?? node;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    async (node: string) => {
      // A failure throws to the poller (it backs off); the state says the link dropped and the last rows stay.
      const sessions = await makeRemoteClient(node, api).sessions();
      beat(node);
      if (!alive.current) return;
      const fresh = sessions.filter((p) => typeof p?.id === 'string' && !p.id.startsWith('dev:')).map((p) => rowOf(node, p));
      const wasAway = awayNodes.current.delete(node);
      setRows((prev) => {
        const here = new Set(fresh.map((r) => r.key));
        // A chat that is gone after its PC was away, or one already marked, stays as it last looked (stopped, not working).
        const kept = (prev[node] ?? []).filter((r) => r.chat && !here.has(r.key) && (r.ended || wasAway)).map((r) => ({ ...r, ended: true, status: 'exited' as PaneInfo['status'] }));
        return { ...prev, [node]: [...fresh, ...kept] };
      });
      setListed((prev) => (prev.has(node) ? prev : new Set(prev).add(node)));
    },
    [api, beat],
  );

  const readQuestions = useCallback(
    async (node: string) => {
      const client = makeRemoteClient(node, api);
      const asked = await client.questions();
      beat(node);
      let list = farQuestionsOf(node, nameOf.current(node), asked, (key) => {
        const known = seenAt.current.get(key);
        if (known !== undefined) return known;
        seenAt.current.set(key, Date.now());
        return Date.now();
      });
      // A PC that lets this one only watch is not asked for answers it would refuse: its cards stay on its own screen.
      if (list.length > 0 && (await client.me()).level === 'watch') list = [];
      if (!alive.current) return;
      const here = new Set(list.map((q) => q.key));
      for (const key of [...seenAt.current.keys()]) if (key.startsWith(`dev:${node}:`) && !here.has(key)) seenAt.current.delete(key);
      setAsked((prev) => ({ ...prev, [node]: list }));
      setHidden((prev) => (prev.size === 0 ? prev : new Set([...prev].filter((key) => !key.startsWith(`dev:${node}:`) || here.has(key)))));
    },
    [api, beat],
  );

  useEffect(() => {
    for (const d of view?.devices ?? []) if (d.state !== 'online') awayNodes.current.add(d.node);
  }, [view]);

  useEffect(() => {
    if (!enabled) return;
    const nodes = onlineKey ? onlineKey.split('|') : [];
    const stops: (() => void)[] = [];
    let live = true;
    for (const node of nodes) {
      subscribeRemote(node, api, (e) => {
        beat(node);
        if (e.type === 'sessions') void read(node).catch(() => undefined);
        else if (e.type === 'questions') void readQuestions(node).catch(() => undefined);
        else if (e.type === 'session-status') setRows((prev) => ({ ...prev, [node]: (prev[node] ?? []).map((r) => (r.paneId === e.id ? { ...r, status: e.status as PaneInfo['status'] } : r)) }));
      })
        .then((stop) => (live ? stops.push(stop) : stop()))
        .catch(() => undefined);
    }
    const polls = nodes.flatMap((node) => [
      pollWithBackoff({ node, route: 'sessions', normalMs: GROUP_POLL_MS, run: () => read(node) }),
      pollWithBackoff({ node, route: 'questions', normalMs: GROUP_POLL_MS, run: () => readQuestions(node) }),
    ]);
    return () => {
      live = false;
      // The set of online PCs changed: each is read again from scratch before anything is said to be gone.
      setListed((prev) => (prev.size === 0 ? prev : new Set()));
      polls.forEach((stop) => stop());
      stops.forEach((s) => s());
    };
  }, [enabled, onlineKey, api, read, readQuestions, beat]);

  // A PC that just came online starts with a fresh beat (its link check just worked).
  const wasOnline = useRef(new Set<string>());
  useEffect(() => {
    for (const node of online) if (!wasOnline.current.has(node) || !beats.current.has(node)) beat(node);
    wasOnline.current = new Set(online);
    for (const key of [...beats.current.keys()]) if (!online.includes(key)) beats.current.delete(key);
  }, [online, beat]);

  // Only a PC with a chat that looks busy is asked the small question every few seconds (the lists come every 15 s, too slow to tell "quiet" from "idle").
  const busyKey = useMemo(() => beatTargets(online, rows).join('|'), [online, rows]);
  useEffect(() => {
    if (!enabled || !busyKey) return;
    const nodes = busyKey.split('|');
    const stops = nodes.map((node) => pollWithBackoff({ node, route: 'beat', normalMs: FAR_BEAT_MS, run: async () => { await makeRemoteClient(node, api).me(); beat(node); } }));
    const tick = window.setInterval(() => {
      // A hidden window or a dead network pauses the checks (nothing could answer): that is not a PC gone quiet.
      if (document.hidden || navigator.onLine === false) {
        for (const node of nodes) beat(node);
        return;
      }
      const next = quietNodes(new Set(nodes), beats.current, Date.now());
      setQuiet((prev) => (prev.size === next.size && [...next].every((n) => prev.has(n)) ? prev : next));
    }, 2_000);
    return () => {
      stops.forEach((stop) => stop());
      window.clearInterval(tick);
      setQuiet((prev) => (prev.size === 0 ? prev : new Set()));
    };
  }, [enabled, busyKey, api, beat]);

  const groups = useMemo<DeviceGroup[]>(() => {
    if (!enabled || !view) return [];
    return view.devices
      // A PC that stopped answering counts as away (its busy chats show Away and the "not answering" line) until its next reply.
      .map((d) => (quiet.has(d.node) && d.state === 'online' ? { ...d, state: 'offline' as const, quiet: true } : d))
      .map((device) => ({ device, rows: (rows[device.node] ?? []).map((r) => ({ ...r, location: deviceLocation(device.node, device.name) })) }))
      .filter((g) => g.rows.length > 0 || g.device.state === 'not_allowed' || g.device.needs_person.length > 0);
  }, [enabled, view, rows, quiet]);

  const questions = useMemo<FarQuestion[]>(() => (enabled ? online.flatMap((node) => asked[node] ?? []).filter((q) => !hidden.has(q.key)) : []), [enabled, online, asked, hidden]);
  const allQuestions = useMemo<FarQuestion[]>(() => (enabled ? online.flatMap((node) => asked[node] ?? []) : []), [enabled, online, asked]);
  const answerQuestion = useCallback(
    async (key: string, answer: { choice_id?: string; text?: string }) => {
      const q = Object.values(asked).flat().find((x) => x.key === key);
      if (!q) return;
      await makeRemoteClient(q.node, api).answerQuestion(q.id, answer);
      // The far PC settled it: it leaves this list now, and the far list is read again (another card may have taken its place).
      setAsked((prev) => ({ ...prev, [q.node]: (prev[q.node] ?? []).filter((x) => x.key !== key) }));
      void readQuestions(q.node).catch(() => undefined);
    },
    [asked, api, readQuestions],
  );
  const hideQuestion = useCallback((key: string) => setHidden((prev) => new Set(prev).add(key)), []);
  const forget = useCallback((key: string) => setRows((prev) => Object.fromEntries(Object.entries(prev).map(([node, list]) => [node, list.filter((r) => r.key !== key)]))), []);

  return { view, enabled, groups, questions, listed, allQuestions, answerQuestion, hideQuestion, refresh, forget, watch };
}
