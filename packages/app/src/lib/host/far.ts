// Another PC: the same commands and events, over the PC link. A command is `POST /pclink/call/<cmd>` with the same args; an
// event is an `app` frame on the far PC's event stream. A refused call comes back as the one sentence the person should read.
//
// The screen holds a far pane under its key (`dev:<node>:<id>`, `placeKey.ts`); this file is the only place that turns it into the far
// PC's own id on the way out and back into the key on the way in. A command the far call table does not have (an older far PC) is
// answered here with one plain sentence (and `can(cmd)` says no, so the control is drawn disabled); nothing is sent for it.
//
// The press and hold: this file never claims one. A `hold` the screen passes goes through as it is; the far PC asks it only of a PC that
// is not the person's own (it knows by the account marker), and says so in one sentence when it is missing.
import { t } from '../../i18n';
import type { DevicesApi } from '../devices';
import { PcLinkError, type PcLinkClient } from '../runtime/pclink';
import { subscribeRemote } from '../runtime/remote';
import { WATCH_CAPS, type Caps, type Host } from './host';
import { idOfKey, placeKey } from './placeKey';

/** The rows of the far call table (`pclink/calls.rs`): keep both in step. */
export const FAR_CALLS: ReadonlySet<string> = new Set([
  'acp_chat_state',
  'agent_model_options',
  'acp_chat_set_config',
  'acp_chat_set_force_yes',
  // ---- P1.7 chat feed ----
  'session_chat_open',
  'session_chat_close',
  'chat_earlier',
  'chat_picture',
  'acp_chat_cancel',
  'pane_message_send',
  'pane_message_cancel',
  'pane_message_hold',
  'pane_message_edit',
  'pane_messages_list',
  'acp_chat_keep_waiting',
  'acp_chat_take_back',
  'acp_chat_set_auto_allow',
  'acp_chat_set_agent_answering',
  'acp_chat_warm',
  // ---- P2.1 agents/projects ----
  'agents_list',
  'agent_lane_get',
  'agent_default_models',
  'agent_rules_effective',
  'project_recent',
  // ---- P3.1 workflows (the ones the New agent page reads and starts) ----
  'workflows_list',
  'workflows_hidden_count',
  'workflows_plan',
  'workflows_start_helpers',
]);

/** The args with the pane key turned into the far PC's own id (`paneId` and `pane_id`, the two spellings a command takes). */
function farArgs(node: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) };
  for (const k of ['paneId', 'pane_id']) if (typeof out[k] === 'string') out[k] = idOfKey(node, out[k] as string);
  return out;
}

/** An event payload from the far PC, its pane id turned into the key this screen holds. */
function rekey<T>(place: Host['place'], payload: T): T {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== 'object') return payload;
  const out: Record<string, unknown> = { ...p };
  for (const k of ['paneId', 'pane_id']) if (typeof out[k] === 'string') out[k] = placeKey(place, out[k] as string);
  return out as T;
}

/** A far refusal that has its own sentence worth showing (the far PC says what to change); any other 403 reads as the general one. */
const OWN_SENTENCE = new Set(['MESSAGE_NEEDS_FULL', 'NEEDS_HOLD', 'AGENT_LOCKED']);

export function farHost(
  client: PcLinkClient,
  events: Pick<DevicesApi, 'subscribe' | 'unsubscribe' | 'onEvent'>,
  /** `calls`: the commands this far PC answers (default: the table above; a far PC that reports its own list passes it). `name`: shown in the one reason line. */
  opts: { name?: string; caps?: Caps; calls?: ReadonlySet<string> } = {},
): Host {
  const place = { kind: 'pc', node: client.node, name: opts.name ?? client.node } as const;
  const calls = opts.calls ?? FAR_CALLS;
  const can = (cmd: string): boolean => calls.has(cmd);
  const notYet = t('host.notYet', { name: place.name });
  const caps = opts.caps ?? WATCH_CAPS;
  const run = async <T,>(go: () => Promise<T>): Promise<T> => {
    try {
      return await go();
    } catch (error) {
      if (error instanceof PcLinkError) {
        if (error.status === 403) throw new Error(error.code && OWN_SENTENCE.has(error.code) && error.said ? error.said : t('pclink.notAllowed'));
        throw new Error(error.said ?? error.message);
      }
      throw error;
    }
  };
  return {
    place,
    live: true,
    can,
    notYet,
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      if (!calls.has(cmd)) return Promise.reject(new Error(notYet));
      return run(() => client.call<T>(cmd, farArgs(client.node, args)));
    },
    listen: async <T,>(event: string, cb: (payload: T) => void) =>
      subscribeRemote(client.node, events, (e) => {
        if (e.type === 'app' && e.event === event) cb(rekey(place, e.payload as T));
      }),
    caps,
    denied: (cap) => (caps[cap] ? null : cap === 'message' || cap === 'answer' ? t('devices.watchOnlyBox', { name: place.name }) : t('host.needsFull', { name: place.name })),
  };
}
