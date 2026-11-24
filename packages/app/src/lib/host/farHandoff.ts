// "Hand off" for a chat of another PC: the same walk as on this PC (`runHandoff`), with every call sent to that PC through its host. The
// note is written there, in that project's folder; the second agent starts there too, on that machine's own agent and sign-in.
// Nothing here knows a path: the far chat's project is its opaque id, and the far PC resolves it. A far TERMINAL agent hands off the same way:
// the brief is typed into its terminal and the second agent is another terminal agent there (`agents/start`, lane terminal). Not in this
// version: "Open file" (it opens a window on the far PC), a second agent on another sign-in than the far PC's own, and a terminal chat.
import { acpChatApi } from '../acpChat';
import { sendPaneMessage } from '../paneOutbox';
import { t } from '../../i18n';
import type { HandoffDeps, HandoffFileStat, HandoffPane } from '../handoff';
import { handoffStamp } from '../handoff';
import type { PcLinkClient } from '../runtime/pclink';
import type { Host } from './host';
import { placeKey } from './placeKey';

/** What the walk needs to know about one far chat from this screen's list of that PC. */
export interface FarChatRow {
  key: string;
  agent: string;
  /** The folder's opaque id on that PC (`agents/start` takes it back). */
  project: string;
  status: string;
  /** A chat (the default) or a terminal agent. */
  chat?: boolean;
}

export function farHandoffDeps(host: Host, client: PcLinkClient, rows: readonly FarChatRow[], select: (key: string) => void, titleOf: (key: string) => string | undefined): HandoffDeps {
  const chat = acpChatApi(host);
  const refused = () => Promise.reject(new Error(t('handoff.farNotYet')));
  // A terminal's status rides no event: while the walk waits, the far PC's terminal list is read again, so "working" and "done" are seen as they happen.
  const live = new Map<string, string>();
  const refresh = async () => {
    try {
      for (const p of (await host.invoke<{ id: string; status: string }[]>('list_panes')) ?? []) live.set(placeKey(host.place, p.id), p.status);
    } catch {
      /* the list keeps what it had */
    }
  };
  // What the first pane named is (a chat or a terminal): a pane just started on that PC is not in the list yet, and is the same kind.
  let chatWalk = true;
  return {
    pane: (key): HandoffPane | undefined => {
      const row = rows.find((r) => r.key === key);
      if (row) chatWalk = row.chat !== false;
      return row
        ? { id: key, agentType: row.agent, cwd: row.project, ...(chatWalk ? { lane: 'acp' } : {}), status: (chatWalk ? undefined : live.get(key)) ?? row.status }
        : { id: key, agentType: '', cwd: '', ...(chatWalk ? { lane: 'acp' } : {}), status: (chatWalk ? undefined : live.get(key)) ?? 'idle' };
    },
    chatState: (key) => chat.state(key),
    send: (key, text) => sendPaneMessage(key, text, undefined, host),
    stat: (key, stamp) => host.invoke<HandoffFileStat>('handoff_file_stat', stamp ? { paneId: key, stamp } : { paneId: key }),
    startTerminal: async (agent, project) => {
      const key = placeKey(host.place, (await client.startAgent({ agent, project, lane: 'terminal' })).pane_id);
      select(key);
      return key;
    },
    startTerminalChat: refused,
    startChat: async (agent, project) => placeKey(host.place, (await client.startAgent({ agent, project, lane: 'chat' })).pane_id),
    setConfig: (key, option, value) => chat.setConfig(key, option, value),
    select,
    titleOf,
    sleep: async (ms) => {
      if (!chatWalk) await refresh();
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    now: () => Date.now(),
    quick: {
      stamp: () => handoffStamp(new Date()),
      prepare: (key, stamp) => host.invoke<{ stamp: string; path: string }>('handoff_quick_prepare', { paneId: key, stamp }),
      appendNotes: (key, stamp, notes) => host.invoke('handoff_quick_append', { paneId: key, stamp: stamp ?? null, notes }),
      archive: (key, stamp) => host.invoke<string>('handoff_quick_archive', { paneId: key, stamp }),
      // The far PC runs the new agent under its own sign-in: this PC never names one for it.
      account: async () => null,
    },
  };
}
