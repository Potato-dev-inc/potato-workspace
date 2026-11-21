// The PC link's client: what this PC says to another PC it is paired with. NOT the phone's bridge client. A phone has bearer
// tokens, four caps and a route table; a PC is a paired device with three levels (Watch, Answer, Full) and its own routes,
// all under `/pclink/` on the far PC (`src-tauri/src/device_link/pclink`). Nothing here imports the phone's client, its
// route names, its event reader or its cap types; `pcLinkSeparation.test.ts` pins that.
//
// The far PC decides every call by the level it gave this PC. A refused call (403) comes back as an error whose text says
// so; the buttons on this side only hide what would be refused.
import type { ChatItem, ChatSource } from '../sessionChatModel';
import type { OutboxMessage } from '../paneOutbox';
import type { AcpChatState } from '../acpChat';
import type { DevicesApi } from '../devices';
import type { UsageSnapshot } from '../usage';
import { pclinkCallPath } from '../host/host';

/** What the far PC lets this PC do. */
export type PcLevel = 'watch' | 'answer' | 'full';

export const PC_LEVELS: readonly PcLevel[] = ['watch', 'answer', 'full'];
const RANK: Record<PcLevel, number> = { watch: 0, answer: 1, full: 2 };
/** Whether `have` reaches `needs` (an unknown level reaches nothing). */
export const atLeast = (have: PcLevel | null | undefined, needs: PcLevel): boolean => !!have && RANK[have] >= RANK[needs];

/** One agent session on the far PC, as its list says. Texts come from the far PC: show them as text only. */
export interface PcSession {
  id: string;
  agent: string;
  title: string;
  status: 'idle' | 'running' | 'blocked' | 'exited' | string;
  /** The folder it works in, as an opaque id (the far PC's path never travels) and its name. */
  project: string;
  folder: string;
  /** A chat session (no terminal behind it). */
  chat: boolean;
  /** The session that started this one (a minion or helper nests under it). */
  parent?: string;
  /** The same, under the name the row has on its own PC (a newer far PC sends both). */
  helper_of?: string;
  /** `minion` | `spin_off`: what the agent that started it made it (a newer far PC). */
  started_as?: 'minion' | 'spin_off' | string;
  /** A standby's own chat: its PC's sidebar draws it as the standby's row, never as an agent. */
  standby?: boolean;
  /** `acp` for a chat session (a newer far PC; `chat` says the same to an older one). */
  lane?: string | null;
  /** The chat works on a separate copy of its project (its `project` and `folder` are the real project's). */
  copy?: boolean;
  /** The workflow mark of this chat on the PC that owns it: the front of a workflow, or a box of its crew. */
  workflow?: { slug: string; role: string; front: boolean; name?: string };
  /** Read-only facts for the chat header and footer. Absent from an older far PC: show nothing then. Names only, never a path. */
  /** The git branch NAME of its folder (null: not a git folder). */
  branch?: string | null;
  /** The model's display name (null: not known). */
  model?: string | null;
  /** The permission mode: `acts_without_asking` runs a message with no card at all. */
  mode?: PcMode;
}

export type PcMode = 'asks' | 'acts_without_asking' | 'unknown';
/** A mode word from a far PC: anything but the two known words is `unknown` (an older or newer far PC never breaks the screen). */
export const pcModeOf = (value: unknown): PcMode | undefined => (value === 'asks' || value === 'acts_without_asking' ? value : value === undefined || value === null ? undefined : 'unknown');
/** A far PC's name (branch, model) as plain short text: no control characters, at most 80 characters; `undefined` when nothing is left. */
export const pcNameOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  // Control, format (bidi, zero-width, tags) and line/paragraph separator characters are dropped; the cut is by code points.
  const kept = Array.from(value).filter((c) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c));
  const text = kept.slice(0, 80).join('').trim();
  return text || undefined;
};

/** `GET /pclink/me`: what the far PC lets this PC do, and whether a question for more is waiting there. */
export interface PcMe {
  level: PcLevel;
  name: string;
  asked: boolean;
}

/** A live transcript read: the newest items, or what changed since `rev`. */
export interface PcTranscript {
  available: boolean;
  reason: string | null;
  source: ChatSource | null;
  waitingFor: string | null;
  rev: number;
  reset: boolean;
  items: ChatItem[];
}

export interface PcAgent {
  id: string;
  label: string;
  chat: boolean;
  terminal: boolean;
}

export interface PcProject {
  id: string;
  name: string;
  state: string;
}

/** What the New agent page needs from the far PC: its agents and the folders it knows (by opaque id: a path never travels). */
export interface PcNewAgentOptions {
  agents: PcAgent[];
  projects: PcProject[];
  /** The far PC's "Show terminals" setting. */
  terminals?: boolean;
  need_terminals?: number;
}

/** One place the far PC lets this PC browse from (its home folder, or the parent of a project it knows), by opaque id. */
export interface PcBrowseRoot {
  id: string;
  name: string;
}

/** The folders inside one place: names only (a path never travels). */
export interface PcBrowseList {
  root: string;
  sub: string;
  name: string;
  entries: { name: string }[];
  truncated: boolean;
}

export interface PcQuestion {
  id: string;
  question: string;
  choices: { id: string; label: string }[];
  allow_free_text: boolean;
  pane_id?: string;
}

/** Everything a PC may ask of another. One method is one route; the far PC enforces the level. */
export interface PcLinkClient {
  readonly node: string;
  /** Any allowlisted command of the far PC: `POST /pclink/call/<cmd>`, same args and same JSON as the Tauri command. */
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  // Watch
  me(): Promise<PcMe>;
  sessions(): Promise<PcSession[]>;
  transcript(id: string, since?: number): Promise<PcTranscript>;
  transcriptEarlier(id: string, before: string, limit?: number): Promise<{ items: ChatItem[]; more: boolean }>;
  picture(id: string, path: string): Promise<{ name: string; mime: string; size: number; dataUrl: string }>;
  agentOptions(): Promise<PcNewAgentOptions>;
  /** The folders the far PC knows, by opaque id. */
  projects(): Promise<PcProject[]>;
  /** The far PC's own usage and limits, in the shape of its own usage bar. */
  usage(): Promise<UsageSnapshot>;
  questions(): Promise<PcQuestion[]>;
  // Answer
  messages(id: string): Promise<OutboxMessage[]>;
  sendMessage(id: string, text: string): Promise<OutboxMessage>;
  cancelMessage(id: string, messageId: string): Promise<OutboxMessage>;
  interrupt(id: string): Promise<void>;
  answerQuestion(id: string, answer: { choice_id?: string; text?: string }): Promise<void>;
  // Full
  modelOptions(agent: string): Promise<unknown>;
  startAgent(args: { agent: string; project: string; lane: 'chat' | 'terminal' }): Promise<{ pane_id: string }>;
  warm(args: { agent: string; project: string }): Promise<void>;
  /** The places the far PC lets this PC browse from (no `root`), or the folders inside one place. */
  browse(root?: string, sub?: string): Promise<{ roots: PcBrowseRoot[] } | PcBrowseList>;
  /** Makes a browsed folder one of the far PC's projects and says which. */
  openFolder(root: string, sub: string): Promise<PcProject>;
  setConfig(id: string, optionId: string, value: string, hold?: boolean): Promise<AcpChatState>;
  close(id: string): Promise<void>;
  moveWork(args: { project: string; branch: string; bundle_b64: string }): Promise<void>;
  /** Asks the person at the far PC to turn "Can work on this PC" on. Nothing is granted by asking. */
  requestFull(): Promise<{ asked: boolean; already?: boolean }>;
}

/** A refused or failed call. The text keeps the status, so `/ -> 403/` reads it. */
export class PcLinkError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`pclink ${method} ${path} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body ?? {})}`);
  }
  /** The far PC's own sentence, when it sent one. */
  get said(): string | null {
    const error = (this.body as { error?: unknown } | null)?.error;
    return typeof error === 'string' && error.trim() ? error.trim() : null;
  }
  get code(): string | null {
    const code = (this.body as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
  }
}

type Request = Pick<DevicesApi, 'request'>;

const seg = encodeURIComponent;

/** The client of one far PC. Every call is one `devices_request` on the far PC's `/pclink/` routes. */
export function makePcLinkClient(node: string, api: Request): PcLinkClient {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await api.request(node, method, path, body);
    if (res.status >= 300) throw new PcLinkError(res.status, res.body, method, path);
    return (res.body ?? {}) as T;
  };
  return {
    node,
    call: (cmd, args) => call('POST', pclinkCallPath(cmd), args ?? {}),
    me: () => call('GET', '/pclink/me'),
    sessions: async () => (await call<{ sessions?: PcSession[] }>('GET', '/pclink/sessions')).sessions ?? [],
    transcript: (id, since) => call('GET', `/pclink/sessions/${seg(id)}/transcript${since === undefined ? '' : `?since=${since}`}`),
    transcriptEarlier: (id, before, limit) => call('GET', `/pclink/sessions/${seg(id)}/transcript/earlier?before=${seg(before)}${limit === undefined ? '' : `&limit=${limit}`}`),
    picture: (id, path) => call('GET', `/pclink/sessions/${seg(id)}/picture?path=${seg(path)}`),
    agentOptions: async () => {
      const [agents, projects] = await Promise.all([call<{ agents?: PcAgent[]; terminals?: boolean; need_terminals?: number }>('GET', '/pclink/agents'), call<{ projects?: PcProject[] }>('GET', '/pclink/projects')]);
      return { agents: agents.agents ?? [], projects: projects.projects ?? [], terminals: agents.terminals, need_terminals: agents.need_terminals };
    },
    projects: async () => (await call<{ projects?: PcProject[] }>('GET', '/pclink/projects')).projects ?? [],
    usage: async () => {
      const snap = await call<Partial<UsageSnapshot>>('GET', '/pclink/usage');
      return { rows: Array.isArray(snap.rows) ? snap.rows : [], refreshed_at_ms: typeof snap.refreshed_at_ms === 'number' ? snap.refreshed_at_ms : 0 };
    },
    browse: (root, sub) => call('GET', `/pclink/browse${root ? `?root=${encodeURIComponent(root)}${sub ? `&sub=${encodeURIComponent(sub)}` : ''}` : ''}`),
    openFolder: async (root, sub) => (await call<{ project: PcProject }>('POST', '/pclink/projects/open', { root, sub })).project,
    questions: async () => (await call<{ questions?: PcQuestion[] }>('GET', '/pclink/questions')).questions ?? [],
    messages: async (id) => (await call<{ messages?: OutboxMessage[] }>('GET', `/pclink/sessions/${seg(id)}/messages`)).messages ?? [],
    sendMessage: async (id, text) => (await call<{ message: OutboxMessage }>('POST', `/pclink/sessions/${seg(id)}/messages`, { text })).message,
    cancelMessage: async (id, messageId) => (await call<{ message: OutboxMessage }>('DELETE', `/pclink/sessions/${seg(id)}/messages/${seg(messageId)}`)).message,
    interrupt: async (id) => void (await call('POST', `/pclink/sessions/${seg(id)}/interrupt`, {})),
    answerQuestion: async (id, answer) => void (await call('POST', `/pclink/questions/${seg(id)}/answer`, answer)),
    modelOptions: (agent) => call('GET', `/pclink/agents/${seg(agent)}/models`),
    startAgent: async (args) => {
      const res = await call<{ pane_id?: string; snapshot?: { pane_id?: string } }>('POST', '/pclink/agents/start', args);
      const paneId = res.pane_id ?? res.snapshot?.pane_id;
      if (!paneId) throw new Error('The far PC started an agent but named none.');
      return { pane_id: paneId };
    },
    warm: async (args) => void (await call('POST', '/pclink/agents/warm', args)),
    setConfig: (id, optionId, value, hold) => call('POST', `/pclink/sessions/${seg(id)}/config`, { option_id: optionId, value, ...(hold ? { hold: true } : {}) }),
    close: async (id) => {
      try {
        await call('DELETE', `/pclink/sessions/${seg(id)}`);
      } catch (error) {
        // Closing a session that is already gone is not an error for the caller.
        if (!(error instanceof PcLinkError && error.status === 404)) throw error;
      }
    },
    moveWork: async (args) => void (await call('POST', '/pclink/move-work', args)),
    requestFull: () => call('POST', '/pclink/full-request', {}),
  };
}

// ----- live events (`GET`-less: the far PC pushes them over the link's own stream) -----

/** What the far PC's event stream says. These are the PC link's own frames (`pclink/events.rs`), not the phone's. */
export type PcEvent = { type: 'sessions' } | { type: 'session-status'; id: string; status: PcSession['status'] } | { type: 'outbox'; id: string } | { type: 'questions' } | { type: 'app'; event: string; payload: unknown };

/** One frame (`event: x\ndata: {...}\n\n`) to its event; null for a comment, an unknown name or noise. */
export function parsePcFrame(frame: string): PcEvent | null {
  let name = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!name) return null;
  let parsed: Record<string, unknown> = {};
  if (data) {
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const id = typeof parsed.id === 'string' ? parsed.id : '';
  switch (name) {
    case 'sessions':
      return { type: 'sessions' };
    case 'questions':
      return { type: 'questions' };
    case 'session-status':
      return id && typeof parsed.status === 'string' ? { type: 'session-status', id, status: parsed.status } : null;
    case 'outbox':
      return id ? { type: 'outbox', id } : null;
    case 'app':
      return typeof parsed.event === 'string' && parsed.event ? { type: 'app', event: parsed.event, payload: parsed.payload } : null;
    default:
      return null;
  }
}
