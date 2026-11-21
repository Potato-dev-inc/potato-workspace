// What the normal pane screen (`PaneView`) reads from the cockpit about ONE far chat and its helpers, made from the far PC's session list:
// the same `PaneData` rows a pane of this PC has (so the header, the helper rows and the crew read them as they always do), the chat's name,
// and the verbs a pane screen calls on the cockpit (`interrupt`, `closePane`, `rename`, `select`) sent to that PC. The far rows are added
// to a copy of the registry the screen is given, never to the cockpit's own, so nothing else on this PC (needs-you, Today, "close all")
// ever sees a far pane. Texts come from the far PC: they are shown as text only.
import type { PaneInfo } from '@potato-workspace/shared';
import type { PaneData } from '../../hooks/usePaneRegistry';
import type { CockpitApi } from '../../hooks/useCockpit';
import { ACP_LANE } from '../acpChat';
import type { PcLinkClient } from '../runtime/pclink';
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
  } as PaneInfo;
  return { info, status: info.status };
};

export function farCockpit(c: CockpitApi, client: PcLinkClient, name: string, rows: readonly FarRow[], notYet: string, openRow: (key: string) => void): CockpitApi {
  const far = rows.map((r) => paneOf(client.node, name, r));
  const panes = new Map(c.registry.panes);
  for (const p of far) panes.set(p.info.id, p);
  const names = new Map(c.names);
  // A pane's name beside its title is its agent's name, as for a pane of this PC.
  for (const r of rows) names.set(r.key, c.launchEntries.find((e) => e.type === r.agent)?.label ?? r.agent);
  const own = (key: string) => rows.some((r) => r.key === key);
  return {
    ...c,
    registry: { ...c.registry, panes, paneList: [...c.registry.paneList, ...far] },
    names,
    // A far pane opens in its own screen; any other goes where it always did.
    select: (id) => (id && own(id) ? openRow(id) : c.select(id)),
    interrupt: (id) => (own(id) ? client.interrupt(idOfKey(client.node, id)) : c.interrupt(id)),
    closePane: async (id) => {
      if (!own(id)) return c.closePane(id);
      await client.close(idOfKey(client.node, id));
      c.select(null);
    },
    rename: async (id, title) => {
      if (!own(id)) return c.rename(id, title);
      c.notify(notYet);
    },
  };
}
