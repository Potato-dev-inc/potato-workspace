// The state of one chat session over ACP (phase, "stopping"): read once when the pane opens and kept fresh by the
// `acp-chat-state` event the backend sends at every change. `null` while unknown, or for a pane that is not one.
// One store per (place, pane) is shared by every view of that pane (the row, the dock, the panel each used to listen and read),
// and a store the last view left lives on a moment, so a quick switch back asks nothing again.
import { useEffect, useMemo, useState } from 'react';
import { acpChatApi, type AcpChatApi, type AcpChatState } from '../lib/acpChat';
import { useHost } from '../lib/host/context';

/** The last view to leave lets go after this long. */
export const ACP_STATE_GRACE_MS = 2000;

interface Entry {
  state: AcpChatState | null;
  subs: Set<(s: AcpChatState | null) => void>;
  refs: number;
  stop: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}
const stores = new WeakMap<object, Map<string, Entry>>();

function join(api: AcpChatApi, key: object, paneId: string): Entry {
  let byPane = stores.get(key);
  if (!byPane) stores.set(key, (byPane = new Map()));
  const had = byPane.get(paneId);
  if (had) {
    if (had.timer) clearTimeout(had.timer);
    had.timer = null;
    had.refs++;
    return had;
  }
  const e: Entry = { state: null, subs: new Set(), refs: 1, stop: null, timer: null, dead: false };
  byPane.set(paneId, e);
  const set = (s: AcpChatState | null) => {
    e.state = s;
    for (const f of [...e.subs]) f(s);
  };
  // Listen before reading, so a change that happens while the read is in flight is not lost.
  void api
    .watch((id, next) => {
      if (!e.dead && id === paneId) set(next);
    })
    .then((stop) => {
      if (e.dead) stop();
      else e.stop = stop;
    })
    .catch(() => undefined);
  api
    .state(paneId)
    .then((first) => {
      // An event that came first is newer than this read.
      if (!e.dead && e.state === null) set(first);
    })
    .catch(() => undefined);
  return e;
}

function leave(key: object, paneId: string, e: Entry, graceMs: number): void {
  if (--e.refs > 0) return;
  const end = () => {
    if (e.refs > 0) return;
    e.dead = true;
    e.stop?.();
    e.stop = null;
    const byPane = stores.get(key);
    if (byPane?.get(paneId) === e) byPane.delete(paneId);
  };
  if (graceMs > 0) e.timer = setTimeout(end, graceMs);
  else end();
}

export function useAcpChatState(paneId: string, enabled: boolean, given?: AcpChatApi): AcpChatState | null {
  const host = useHost();
  const own = useMemo(() => acpChatApi(host), [host]);
  const api = given ?? own;
  const [state, setState] = useState<AcpChatState | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    // Keyed by the host when the api is the host's own, so two views of one pane share (each view's own api object is new).
    // A far pane: the host's link wins over a given api, since the screen's views (header, panel, row) pass different api objects for one PC.
    const key: object = host.link ?? given ?? host;
    const e = join(api, key, paneId);
    setState(e.state);
    e.subs.add(setState);
    return () => {
      e.subs.delete(setState);
      leave(key, paneId, e, ACP_STATE_GRACE_MS);
    };
  }, [paneId, enabled, api, given, host]);

  return state;
}
