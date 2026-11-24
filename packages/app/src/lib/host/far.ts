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
import { rawText } from '../sayError';
import type { DevicesApi } from '../devices';
import { PcLinkError, type PcLinkClient } from '../runtime/pclink';
import { subscribeRemote } from '../runtime/remote';
import { WATCH_CAPS, type Caps, type Host } from './host';
import { idOfKey, placeKey } from './placeKey';

/** How long a message to a far PC waits for its answer before the box says the PC is not answering. */
export const SEND_PATIENCE_MS = 6000;

/** Reads that change nothing: the same one asked twice while the first is out is answered by it (a chat that opens asks each of them). */
export const FAR_SHARED_READS: ReadonlySet<string> = new Set([
  'acp_chat_state', 'agent_model_options', 'pane_messages_list', 'agents_list', 'agent_lane_get', 'agent_default_models', 'agent_rules_effective',
  'project_recent', 'files_list', 'files_marks', 'checkpoints_list', 'pane_git_branch', 'pane_worktree', 'pane_previews', 'pane_usage', 'usage_snapshot', 'workflows_list', 'workflows_hidden_count', 'acp_closed_list',
]);
/** Of those, the ones whose answer is also kept a moment (a branch name or a file list does not change in a second). */
export const FAR_BRIEF_CACHE_MS: Readonly<Record<string, number>> = { pane_git_branch: 1000, pane_previews: 1000, pane_usage: 1500, pane_messages_list: 1500, usage_snapshot: 3000, checkpoints_list: 1000, agent_default_models: 4000, agent_rules_effective: 4000, agent_model_options: 4000, acp_closed_list: 3000, files_list: 1000, files_marks: 1000, agents_list: 1000, agent_lane_get: 1000, project_recent: 1000, workflows_list: 1000, workflows_hidden_count: 1000 };
/** An answer still out is joined only while this young. */
export const FAR_JOIN_MS = 300;

/** The per-chat reads a chat's screen makes together when it opens: one `pane_open_bundle` answers them (each once, while the bundle is this young). */
export const FAR_BUNDLED: ReadonlySet<string> = new Set(['pane_usage', 'artifacts_sync', 'pane_git_branch', 'pane_worktree', 'checkpoints_list']);
export const FAR_BUNDLE_MS = 3000;

interface Reads {
  running: Map<string, { at: number; promise: Promise<unknown> }>;
  kept: Map<string, { at: number; value: unknown }>;
  /** The open bundle of each chat: one per far PC, so a host made again (its level arrived) does not ask for it twice. */
  bundles: Map<string, { at: number; parts: Promise<Record<string, unknown>> }>;
}
/** What every chat of one far PC shares (a read with no chat in it, like the usage bar or the model list, is asked once for all of them), per events source. */
const readsOf = new WeakMap<object, Map<string, Reads>>();
function sharedReads(events: object, node: string): Reads {
  const byNode = readsOf.get(events) ?? readsOf.set(events, new Map()).get(events)!;
  return byNode.get(node) ?? byNode.set(node, { running: new Map(), kept: new Map(), bundles: new Map() }).get(node)!;
}

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
  // ---- P6.1 use my own agents (`calls_lend.rs`) ----
  'own_borrow_ask',
  // ---- P5 files, git, checkpoints, artifacts, previews, usage (`pclink/calls_files.rs`; the files and git rows are Full there) ----
  'files_list',
  'files_read',
  'files_read_bytes',
  'files_marks',
  'files_diff',
  'files_search_contents',
  'files_search_cancel',
  'project_files_search',
  'files_write',
  'checkpoints_list',
  'checkpoint_diff',
  'checkpoint_turn_review',
  'checkpoint_file_patch',
  'checkpoint_put_back',
  'checkpoint_restore',
  'checkpoint_undo_last',
  'pane_git_branch',
  'artifacts_read',
  'artifacts_sync',
  'pane_previews',
  'pane_usage',
  'usage_snapshot',
  // ---- P6.2 install on the far PC (Full; the far PC builds the plan and refuses a changed command) ----
  'agents_install_plan',
  'agents_install_run',
  'agents_install_status',
  'agents_install_finish',
  'agents_detect_installed',
  'spawn_pane',
  'list_panes',
  'write_pane_input',
  'resize_pane',
  'kill_pane_cmd',
  'read_pane_screen_replay',
  'read_pane_raw_buffer',
  // ---- P4a Ask aside, Hand off, Share, closed chats, search ----
  'side_question_target',
  'side_question_ask',
  'handoff_file_stat',
  'handoff_quick_prepare',
  'handoff_quick_append',
  'handoff_quick_archive',
  'handoff_pane_account',
  'chat_export_html',
  'chat_export_markdown',
  'acp_closed_list',
  'acp_reopen_closed',
  'acp_delete_closed',
  'chat_search',
  'chat_search_facets',
  // ---- P4b attach and start ----
  'attachment_prepare',
  'attachment_save_pasted',
  'acp_chat_start',
  // ---- P45 gaps: a chat's separate copy (Changes, Keep, Discard) and a picture's thumbnail ----
  'pane_set_title',
  'pane_worktree',
  'pane_open_bundle',
  'worktree_diff',
  'worktree_merge',
  'worktree_discard',
  'attachment_preview',
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

/** A chat state in which this PC is the driver says nobody else drives: the far PC names the driver by the id it gave THIS PC (`/pclink/me` `you`),
 * so "<this PC> is driving / Take back" would name the PC that is looking at it. A different driver (a phone, a third PC) stays. */
export function withoutSelfAsDriver<T>(state: T, you: string | undefined): T {
  const s = state as { drive?: { driver?: { id?: string } | null } } | null;
  if (!you || s?.drive?.driver?.id !== you) return state;
  return { ...s, drive: { ...s.drive, driver: null } } as T;
}

/** The commands that name a file by its path. */
const NAMED: ReadonlySet<string> = new Set(['files_read', 'files_read_bytes', 'files_write', 'files_diff', 'files_marks']);

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
        // The far PC's own code rides on the error (as a local command's `CODE: sentence` does), so a screen that tells a file conflict from any
        // other failure (`errorCode`, `sayError`) tells it on a far file too. A reply with no sentence of its own is never shown as the raw request.
        const coded = (text: string) => Object.assign(new Error(text), error.code ? { code: error.code } : {});
        if (error.status === 403) throw coded(error.code && OWN_SENTENCE.has(error.code) && error.said ? error.said : t('pclink.notAllowed'));
        if (error.status === 404 && error.code === 'UNKNOWN_ROUTE') throw coded(notYet);
        throw coded(error.said ?? t('pclink.unreachable'));
      }
      throw error;
    }
  };
  // Who this PC is to the far PC, read once (a failure is tried again next time; an older far PC has none, and then nothing is dropped).
  let you: Promise<string | undefined> | null = null;
  const whoAmI = (): Promise<string | undefined> => (you ??= Promise.resolve().then(() => client.me()).then((me) => me.you, () => ((you = null), undefined)));
  let own: Promise<boolean | undefined> | null = null;
  const { running, kept, bundles } = sharedReads(events, client.node);
  // Each part of a chat's bundle is given out once to this host (a later poll of it is one plain call); the bundle itself is the PC's.
  const given = new Set<string>();
  let noBundle = false;
  /** One far call for every identical read in flight together (and a brief cache for the cheap ones). */
  const shared = <T,>(cmd: string, args: Record<string, unknown> | undefined, go: () => Promise<T>): Promise<T> => {
    if (!FAR_SHARED_READS.has(cmd)) {
      kept.clear(); // anything else may be a write: no kept answer is still true
      return go();
    }
    const key = `${cmd}|${JSON.stringify(args ?? null)}`;
    const now = Date.now();
    const ttl = FAR_BRIEF_CACHE_MS[cmd];
    const hit = ttl ? kept.get(key) : undefined;
    if (hit && now - hit.at < ttl!) return Promise.resolve(hit.value as T);
    const live = running.get(key);
    if (live && now - live.at < FAR_JOIN_MS) return live.promise as Promise<T>;
    const mine = { at: now, promise: go() as Promise<unknown> };
    running.set(key, mine);
    mine.promise.then(
      (value) => {
        if (running.get(key) === mine) running.delete(key);
        if (ttl) {
          kept.set(key, { at: Date.now(), value });
          if (kept.size > 100) kept.delete(kept.keys().next().value as string);
        }
      },
      () => {
        if (running.get(key) === mine) running.delete(key);
      },
    );
    return mine.promise as Promise<T>;
  };
  return {
    place,
    live: true,
    can,
    notYet,
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      if (!calls.has(cmd)) return Promise.reject(new Error(notYet));
      // A file name that is not valid text (a Latin-1 name on Linux) reaches this PC with U+FFFD in it, and the far PC would look for a file that does not exist.
      if (NAMED.has(cmd) && Object.values(args ?? {}).some((v) => typeof v === 'string' && v.includes('�'))) return Promise.reject(new Error(t('host.oddName', { name: place.name })));
      // A message to a PC that does not answer says so after a few seconds (the text stays in the box) instead of waiting for the link to give up.
      const call = () => client.call<T>(cmd, farArgs(client.node, args));
      const quick = cmd === 'pane_message_send' ? () => Promise.race([call(), new Promise<never>((_, no) => setTimeout(() => no(Object.assign(new Error(t('host.noAnswer', { name: place.name })), { code: 'NO_ANSWER' })), SEND_PATIENCE_MS))]) : call;
      const only = args && Object.keys(args).length === 1 && typeof args.paneId === 'string' ? args.paneId : null;
      // Only the chat's opening is bundled: a later poll of one of these is that one call, never five.
      const old = only ? bundles.get(only) : undefined;
      // A bundle that is no longer young is for a chat opened again (a host that has taken none of it); this host's own later polls go plain.
      const stale = !!old && Date.now() - old.at > FAR_BUNDLE_MS;
      const opened = !!only && [...given].some((k) => k.startsWith(`${only}|`));
      if (only && FAR_BUNDLED.has(cmd) && can('pane_open_bundle') && !noBundle && !(stale && opened) && !given.has(`${only}|${cmd}`)) {
        const now = Date.now();
        let b = stale ? undefined : old;
        if (!b) {
          const parts = run(() => client.call<{ parts?: Record<string, unknown> }>('pane_open_bundle', farArgs(client.node, { paneId: only }))).then(
            (r) => (r && typeof r.parts === 'object' && r.parts ? r.parts : {}),
            (e: unknown) => {
              // A far PC that has no such row: never asked again; any other failure leaves the single calls to do it.
              if (rawText(e) === notYet) noBundle = true;
              return {};
            },
          );
          b = { at: now, parts };
          bundles.set(only, b);
        }
        given.add(`${only}|${cmd}`);
        const got = b.parts.then((parts) => (cmd in parts ? { value: parts[cmd] } : undefined));
        return got.then((hit) => (hit ? (hit.value as T) : plain()));
      }
      return plain();
      function plain(): Promise<T> {
        return shared(cmd, args, () =>
          run(async () => {
            const out = await quick();
            // A started chat's id is the far PC's own: the screen selects chats by key.
            if (cmd === 'acp_chat_start') return rekey(place, out);
            return cmd === 'acp_chat_state' ? withoutSelfAsDriver(out, await whoAmI()) : out;
          }),
        );
      }
    },
    listen: async <T,>(event: string, cb: (payload: T) => void) => {
      const me = event === 'acp-chat-state' ? await whoAmI() : undefined;
      return subscribeRemote(client.node, events, (e) => {
        if (e.type !== 'app' || e.event !== event) return;
        const payload = rekey(place, e.payload as T);
        const state = (payload as { state?: unknown } | null)?.state;
        cb(me && state ? ({ ...payload, state: withoutSelfAsDriver(state, me) } as T) : payload);
      });
    },
    forceYesDenied: async () => ((await (own ??= Promise.resolve().then(() => client.me()).then((me) => me.own, () => ((own = null), undefined)))) === false ? t('forceYes.farOnly', { name: place.name }) : null),
    caps,
    denied: (cap) => (caps[cap] ? null : cap === 'message' || cap === 'answer' ? t('devices.watchOnlyBox', { name: place.name }) : t('host.needsFull', { name: place.name })),
  };
}
