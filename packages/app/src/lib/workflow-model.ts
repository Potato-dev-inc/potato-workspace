// The live state of one workflow as the chat of its front sees it (Labs "Workflows"). The same pane data the crew chip reads
// (parent links, started_as, status) plus the saved crew for the box names. Used by the details-column pane, the inline card
// and the sidebar row. Nothing is stored here and no new backend: the "this chat is a workflow front" mark is the one
// `lib/crew-members` already keeps.
import { useEffect, useMemo, useState } from 'react';
import { t as translate } from '../i18n';
import type { Crew } from './crews-api';
import { crewsApiFor, type CrewsApi } from './crews-api';
import { useHost } from './host/context';
import { crewMembers, crewCounts, type CrewMember as Member } from './crew-chip';
import { crewOf, useCrewMarks, type CrewMember as Mark } from './crew-members';
import { liveHelpers, roleStates, useLiveFeed, workflowStatus, type LiveFeed, type LiveHelper, type LivePane, type RoleLive } from './workflow-live';

type Tr = typeof translate;

/** The mark of a chat that is the front of a workflow (and Labs "Workflows" is on), else null. */
export function workflowMark(paneId: string | null | undefined, enabled: boolean): (Mark & { front: true }) | null {
  if (!enabled) return null;
  const m = crewOf(paneId);
  return m?.front ? (m as Mark & { front: true }) : null;
}

/** The helpers of a front chat: with the crew each stands in its box; without it (not loaded) each is its own box. */
export function helpersOfFront(crew: Crew | null, panes: ReadonlyArray<LivePane>, frontId: string, agentNameOf: (p: LivePane) => string, asking?: ReadonlySet<string>): LiveHelper[] {
  if (crew) return liveHelpers(crew, panes, frontId, agentNameOf, asking);
  return crewMembers(panes, frontId, agentNameOf, asking).map((m: Member): LiveHelper => ({ ...m, roleKey: null, who: m.title }));
}

export interface WorkflowModel {
  paneId: string;
  slug: string;
  /** The workflow's name (the saved crew's, else the one remembered with the mark). */
  name: string | null;
  crew: Crew | null;
  /** Whether the front agent itself is working now. */
  frontWorking: boolean;
  helpers: LiveHelper[];
  roles: ReadonlyMap<string, RoleLive>;
  feed: LiveFeed;
}

/** What the sidebar row and the card say: the name, then how many work and how many need the person. */
export function workflowLine(name: string | null, helpers: ReadonlyArray<{ state: string }>, t: Tr = translate): string {
  return [workflowName(name, t), workflowCounts(helpers, t)].filter(Boolean).join(' · ');
}

/** "Workflow: Research + Write". */
export const workflowName = (name: string | null, t: Tr = translate): string => (name ? t('wfdock.title', { name }) : t('wfdock.titleNoName'));

/** "1 needs you · 2 working" (the crew chip's order), "done" once all finished, empty before any agent started. */
export function workflowCounts(helpers: ReadonlyArray<{ state: string }>, t: Tr = translate): string {
  const c = crewCounts(helpers as never);
  const parts: string[] = [];
  if (c.needsYou) parts.push(t('wfdock.n.needsYou', { count: c.needsYou }));
  if (c.failed) parts.push(t('wfdock.n.failed', { count: c.failed }));
  if (c.working) parts.push(t('wfdock.n.working', { count: c.working }));
  if (c.total > 0 && c.working + c.needsYou + c.failed === 0) parts.push(t('wfdock.allDone'));
  return parts.join(' · ');
}

/** The state the row's dot shows: the most pressing of its agents. */
export function workflowTone(helpers: ReadonlyArray<{ state: string }>): 'needs-you' | 'failed' | 'working' | 'done' {
  if (helpers.some((h) => h.state === 'needs-you')) return 'needs-you';
  if (helpers.some((h) => h.state === 'failed')) return 'failed';
  if (helpers.some((h) => h.state === 'working')) return 'working';
  return 'done';
}

/**
 * The model of a workflow front chat, or null for any other chat (or with the Labs switch off: then nothing is read).
 * `panes` is the app's pane list; `asking` the panes with a question open.
 */
export function useWorkflowModel(
  paneId: string,
  panes: ReadonlyArray<LivePane>,
  enabled: boolean,
  agentNameOf: (p: LivePane) => string,
  asking?: ReadonlySet<string>,
  api?: Pick<CrewsApi, 'get'>,
): WorkflowModel | null {
  useCrewMarks();
  // The crew is read from the place the chat runs: this PC's saved crews, or the far PC's own (a far project shows its workflows).
  const host = useHost();
  const hostApi = useMemo(() => crewsApiFor(host), [host]);
  const crewApi = api ?? hostApi;
  // The far PC says when this workflow gained helpers (a `workflow-state` event): read the crew again.
  const [rev, setRev] = useState(0);
  const mark = workflowMark(paneId, enabled);
  const slug = mark?.slug ?? null;
  useEffect(() => {
    if (!slug) return undefined;
    let live = true;
    let off: (() => void) | null = null;
    host.listen('workflow-state', () => setRev((n) => n + 1)).then(
      (un) => (live ? (off = un) : un()),
      () => undefined,
    );
    return () => {
      live = false;
      off?.();
    };
  }, [host, slug]);
  const [crew, setCrew] = useState<Crew | null>(null);
  // The log starts once the crew is known (or could not be read), so it names agents by their box from its first line.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!slug) {
      setCrew(null);
      setSettled(false);
      return undefined;
    }
    let live = true;
    Promise.resolve()
      .then(() => crewApi.get(slug))
      .then(
        (c) => {
          if (!live) return;
          setCrew(c && Array.isArray((c as Crew).roles) ? c : null);
          setSettled(true);
        },
        () => live && setSettled(true),
      );
    return () => {
      live = false;
    };
  }, [slug, crewApi, rev]);
  const front = slug ? panes.find((p) => p.info.id === paneId) : undefined;
  // The helpers change only when a pane, a status, a title or a question changes: a signature keeps the memo steady.
  const sig = slug ? [...panes.filter((p) => p.info.parent_pane_id || p.info.id === paneId).map((p) => `${p.info.id}:${p.info.parent_pane_id ?? ''}:${p.status}:${p.info.title ?? ''}`), ...(asking ? [...asking] : [])].join('|') : '';
  const helpers = useMemo(
    () => (slug ? helpersOfFront(crew, panes, paneId, agentNameOf, asking) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, crew, sig, paneId],
  );
  const feed = useLiveFeed(helpers, !!slug && settled);
  const roles = useMemo(() => roleStates(helpers, feed.endedAt), [helpers, feed.endedAt]);
  return useMemo(
    () => (slug && front ? { paneId, slug, name: mark?.name || crew?.name?.trim() || null, crew, frontWorking: front.status === 'running', helpers, roles, feed } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, front?.status, crew, helpers, roles, feed, paneId],
  );
}

/** Whether a front has any helper activity worth showing (a card, a row): it started at least one agent. */
export const hasActivity = (m: Pick<WorkflowModel, 'helpers'> | null): boolean => !!m && m.helpers.length > 0;

export { workflowStatus };
