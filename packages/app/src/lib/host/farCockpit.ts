// What the normal pane screen (`PaneView`) reads from the cockpit about ONE far chat and its helpers, made from the far PC's session list:
// the same `PaneData` rows a pane of this PC has (so the header, the helper rows and the crew read them as they always do), the chat's name,
// and the verbs a pane screen calls on the cockpit (`interrupt`, `closePane`, `rename`, `select`) sent to that PC. The far rows are added
// to a copy of the registry the screen is given, never to the cockpit's own, so nothing else on this PC (needs-you, Today, "close all")
// ever sees a far pane. Texts come from the far PC: they are shown as text only.
import type { PaneInfo } from '@potato-workspace/shared';
import type { PaneData } from '../../hooks/usePaneRegistry';
import type { CockpitApi } from '../../hooks/useCockpit';
import { ACP_LANE } from '../acpChat';
import { t } from '../../i18n';

/** The name of an agent this PC does not list (it is not installed here): the id with a capital, so "agy" reads "Agy", as on its own PC. */
export const farAgentName = (id: string): string => (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);
import { PcLinkError, type PcLinkClient } from '../runtime/pclink';
import type { FarNeeds } from '../../hooks/useNeedsYou';
import type { Question } from '../questions';
import { farQuestionKey } from '../runtime/farQuestions';
import { errorSentence } from '../sayError';
import { idOfKey } from './placeKey';

/** One session of the far PC as the Projects list holds it (`RemoteRow`): its key is `dev:<node>:<id>`. */
export interface FarRow {
  key: string;
  paneId: string;
  title: string;
  agent: string;
  status: PaneInfo['status'];
  /** The folder's name there (never its path). */
  cwd: string;
  chat: boolean;
  parent?: string;
  startedAs?: 'minion' | 'spin_off';
  standby?: boolean;
  copy?: boolean;
  /** The far PC's opaque id of the real project (a copy's chat names its project, not the copy). */
  project?: string;
  /** The number the owning PC gave the chat among its agent's chats, and how many there are. */
  nameN?: number;
  nameOf?: number;
}

/** A far chat's name: its agent's name, numbered the way its OWN PC numbers it ("Claude 5"), never renumbered here. */
export const farChatName = (label: string, row: Pick<FarRow, 'nameN' | 'nameOf'>): string | null => (row.nameN && row.nameOf ? (row.nameOf > 1 || row.nameN > 1 ? `${label} ${row.nameN}` : label) : null);

/**
 * Two chats of one agent on one PC never share a name. The owning PC's numbers win; a chat the owner sent no number for keeps the name this
 * PC counted for it, unless the owner (or an earlier chat) already uses it: then it takes the next free number.
 */
export function uniqueFarNames(names: Map<string, string>, rows: readonly Pick<FarRow, 'key' | 'agent' | 'nameN'>[], labelOf: (agent: string) => string): void {
  const taken = new Set<string>();
  for (const r of rows) if (r.nameN) taken.add(names.get(r.key) ?? '');
  const next = new Map<string, number>();
  for (const r of rows) {
    const name = names.get(r.key);
    if (!name || r.nameN) continue;
    if (taken.has(name)) {
      const label = labelOf(r.agent);
      let n = next.get(r.agent) ?? Math.max(1, ...[...taken].map((x) => (x.startsWith(`${label} `) ? Number(x.slice(label.length + 1)) || 0 : 0))) + 1;
      while (taken.has(`${label} ${n}`)) n += 1;
      next.set(r.agent, n + 1);
      names.set(r.key, `${label} ${n}`);
    }
    taken.add(names.get(r.key)!);
  }
}

export const paneOf = (node: string, name: string, row: FarRow): PaneData => {
  const info = {
    id: row.key,
    agent_type: row.agent,
    pid: 0,
    status: row.status,
    created_at: 0,
    last_output_at: null,
    cwd: row.cwd,
    cols: 80,
    rows: 24,
    title: row.title || null,
    ...(row.parent ? { parent_pane_id: `dev:${node}:${row.parent}` } : {}),
    // The one badge of a far chat: the name of the PC (`placeLabel`).
    place: { kind: 'device', distro: name, cwd: '', mount_root: '', unc_root: '' },
    ...(row.chat ? { lane: ACP_LANE } : {}),
    ...(row.startedAs ? { started_as: row.startedAs } : {}),
    // A standby's own chat: the seat id is its PC's, only that it is one matters here.
    ...(row.standby ? { standby_seat: 'far' } : {}),
    // What "Switch to the borrowed sign-in" needs: the far PC knows a project by this id, never by its folder name (`startOnLend`).
    ...(row.project ? { far_project: row.project, far_copy: row.copy === true } : {}),
  } as PaneInfo;
  return { info, status: info.status };
};

/** What this far PC's chats ask, as the `asked` a pane screen reads. A card keeps the far PC's own id (its chat state names it that way) and
 * its pane becomes the key this screen holds; answering goes to that PC. Dismiss only hides it here (the far agent still waits). */
const askedOf = (node: string, needs: FarNeeds): CockpitApi['asked'] => ({
  questions: (needs.chatQuestions ?? needs.questions)
    .filter((q) => q.node === node)
    .map((q): Question => ({ id: q.id, question: q.question, choices: q.choices, allow_free_text: q.allowFreeText, urgency: 'normal', created_at_ms: q.seenAt, expires_at_ms: q.seenAt + q.waitMs, state: 'pending', ...(q.paneId ? { pane_id: `dev:${node}:${q.paneId}` } : {}), ...(q.kind ? { kind: q.kind } : {}) })),
  answerQuestion: (id, answer) => needs.answer(farQuestionKey(node, id), answer),
  dismissQuestion: async (id) => needs.hide(farQuestionKey(node, id)),
});

export function farCockpit(c: CockpitApi, client: PcLinkClient, name: string, rows: readonly FarRow[], notYet: string, openRow: (key: string) => void, needs: FarNeeds | null = null): CockpitApi {
  const far = rows.map((r) => paneOf(client.node, name, r));
  const panes = new Map(c.registry.panes);
  for (const p of far) panes.set(p.info.id, p);
  const names = new Map(c.names);
  // A pane's name beside its title is its agent's name, as for a pane of this PC.
  for (const r of rows) {
    const label = c.launchEntries.find((e) => e.type === r.agent)?.label ?? farAgentName(r.agent);
    names.set(r.key, farChatName(label, r) ?? label);
  }
  const own = (key: string) => rows.some((r) => r.key === key);
  return {
    ...c,
    registry: { ...c.registry, panes, paneList: [...c.registry.paneList, ...far] },
    names,
    ...(needs ? { asked: askedOf(client.node, needs) } : {}),
    // A far pane opens in its own screen; any other goes where it always did.
    // A chat this PC just started (the far list has not shown it yet) is this PC's too: the screen opens it by key.
    select: (id) => (id && (own(id) || id.startsWith(`dev:${client.node}:`)) ? openRow(id) : c.select(id)),
    interrupt: (id) => (own(id) ? client.interrupt(idOfKey(client.node, id)) : c.interrupt(id)),
    closePane: async (id) => {
      if (!own(id)) return c.closePane(id);
      await client.close(idOfKey(client.node, id));
      c.select(null);
      // No undo bar: the far chat is not deleted, it waits in Closed chats.
      c.notify(t('pane.closedFar', { name: names.get(id) ?? '' }));
    },
    rename: async (id, title) => {
      if (!own(id)) return c.rename(id, title);
      try {
        await client.call('pane_set_title', { paneId: idOfKey(client.node, id), title });
      } catch (e) {
        // An older far PC has no such call: the one plain line; any other refusal says what the far PC said.
        c.notify(e instanceof PcLinkError ? (e.status === 404 && e.code === 'UNKNOWN_ROUTE' ? notYet : e.status === 403 ? t('pclink.notAllowed') : (e.said ?? t('pclink.unreachable'))) : errorSentence(e));
      }
    },
  };
}
