// HTTP client for the Potato Workspace bridge (Rust side, default 127.0.0.1:17421): URL discovery and
// the typed BridgeClient. Wire types live in ./bridge-types, SSE subscription in ./bridge-sse.
import { BRIDGE_HTTP_PORT_RANGE, type AgentContextProfile } from '@potato-workspace/shared';
import { invoke } from '@tauri-apps/api/core';
import { ngrokRequestHeaders } from './bridge-ngrok';
import { decodeBase64, streamOffset } from './bridge-sse';
import type { BridgeClient, PaneRuleView, PaneViewportResponse, PhoneClosedChat } from './bridge-types';
import type { Question } from './questions';
import { mergeBridgeHeaders } from './mobile-pairing-auth';
import { localSecretHeaders } from './bridge-local-secret';
import type { PreviewUrl } from './pane-preview';
import type { OutboxMessage } from './paneOutbox';
import type { ChatAttachment } from './attachFiles';
import type { CompanionView, FeedItem, MemoryView } from './companion';
import { AttentionAnswerError, type AttentionAnswerOutcome, type AttentionSnapshot } from './attention';

export type * from './bridge-types';
export { subscribeBridgeEvents } from './bridge-sse';

/** The ports the bridge scans (Potato Workspace's own range, not the other product's 17321-17399). */
const BRIDGE_PORT_MIN = BRIDGE_HTTP_PORT_RANGE.min;
const BRIDGE_PORT_MAX = BRIDGE_HTTP_PORT_RANGE.max;
const DEFAULT_POLL_HOST = '127.0.0.1';
const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * The proxy in front of the app (dev Vite proxy, built-app phone server) answers 502 BRIDGE_UNREACHABLE
 * with a plain-language message when the app's bridge is down; show that, not the raw JSON.
 */
function bridgeErrorText(status: number, body: string): string {
  if (status === 502) {
    try {
      const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
      if (parsed.code === 'BRIDGE_UNREACHABLE' && typeof parsed.message === 'string') return parsed.message;
    } catch {
      /* not JSON: keep the body as is */
    }
  }
  return body;
}

/**
 * Another way to carry a bridge call than `fetch`: the PC link to a paired device (`lib/runtime/remote.ts`). It answers
 * the status and the body text of the far bridge's reply, the same as an HTTP response would.
 */
export type BridgeTransport = (method: string, path: string, body?: unknown) => Promise<{ status: number; text: string }>;

export function makeBridgeClient(baseUrl: string, transport?: BridgeTransport): BridgeClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (transport) {
      const res = await transport(method, path, body || undefined);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`bridge ${method} ${path} -> ${res.status}: ${bridgeErrorText(res.status, res.text)}`);
      }
      return (res.text ? JSON.parse(res.text) : {}) as T;
    }
    const headers = mergeBridgeHeaders({ ...ngrokRequestHeaders(baseUrl), ...localSecretHeaders(baseUrl) });
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`bridge ${method} ${path} -> ${res.status}: ${bridgeErrorText(res.status, await res.text())}`);
    }
    return (await res.json()) as T;
  }
  return {
    baseUrl,
    listPanes: () => call('GET', '/panes'),
    listPreviews: async () => (await call<{ previews: Record<string, PreviewUrl[]> }>('GET', '/previews')).previews ?? {},
    spawnPane: async (args) => {
      // The route answers `{ ok, snapshot: { pane_id }, suggested_wait }` (MCP hint envelope).
      const res = await call<{ pane_id?: string; snapshot?: { pane_id?: string } }>('POST', '/panes', args);
      const paneId = res.snapshot?.pane_id ?? res.pane_id;
      if (!paneId) throw new Error('spawn returned no pane id');
      return { pane_id: paneId };
    },
    // Closing a pane that is already gone is not an error for the caller: the route answers a typed
    // 404 (PANE_NOT_FOUND) for an unknown id, which a stale phone screen can legitimately send.
    killPane: async (id) => {
      try {
        await call('DELETE', `/panes/${encodeURIComponent(id)}`);
      } catch (error) {
        if (!(error instanceof Error && / -> 404:/.test(error.message))) throw error;
      }
    },
    stopAllPanes: () => call('POST', '/panes/stop-all', {}),
    interruptPane: (id) => call('POST', `/panes/${encodeURIComponent(id)}/interrupt`, {}),
    paneRules: async () => (await call<{ rules?: Record<string, PaneRuleView> }>('GET', '/pane-rules')).rules ?? {},
    askControl: (id) => call('POST', '/control-asks', { pane_id: id }),
    attention: () => call<AttentionSnapshot>('GET', '/attention'),
    answerAttention: async (itemId, body, signal) => {
      const headers = mergeBridgeHeaders({ ...ngrokRequestHeaders(baseUrl), ...localSecretHeaders(baseUrl) });
      headers['Content-Type'] = 'application/json';
      const res = await fetch(`${baseUrl}/attention/${encodeURIComponent(itemId)}/answer`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      const reply = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new AttentionAnswerError(res.status, reply as AttentionAnswerError['body']);
      return reply as unknown as AttentionAnswerOutcome;
    },
    listQuestions: async () => (await call<{ questions: Question[] }>('GET', '/questions')).questions,
    answerQuestion: (id, answer) => call('POST', `/questions/${encodeURIComponent(id)}/answer`, answer),
    dismissQuestion: (id) => call('POST', `/questions/${encodeURIComponent(id)}/dismiss`, {}),
    setPaneViewport: (id, view) =>
      call<PaneViewportResponse>('POST', `/panes/${encodeURIComponent(id)}/viewport`, view),
    listAgentTypes: () => call('GET', '/agents/types'),
    digest: (opts) => {
      const q = new URLSearchParams();
      if (opts?.since !== undefined) q.set('since', String(opts.since));
      if (opts?.seen) q.set('seen', '1');
      const qs = q.toString();
      return call('GET', `/digest${qs ? `?${qs}` : ''}`);
    },
    teamCards: () => call('GET', '/team/cards'),
    phoneDone: (since) => call('GET', `/phone/done?since=${Math.max(0, Math.floor(since))}`),
    phoneHelpers: () => call('GET', '/phone/helpers'),
    teamDismiss: (id) => call('POST', `/team/cards/${encodeURIComponent(id)}/dismiss`, {}),
    teamPull: (id) => call('POST', `/team/cards/${encodeURIComponent(id)}/pull`, {}),
    teamQueue: (id, paneId, when) => call('POST', `/team/cards/${encodeURIComponent(id)}/queue`, { paneId, when }),
    teamApply: (id) => call('POST', `/team/jobs/${encodeURIComponent(id)}/apply`, {}),
    teamDiscard: (id) => call('POST', `/team/jobs/${encodeURIComponent(id)}/discard`, {}),
    readBuffer: async (id, lines) => {
      const res = await call<{ content: string }>('GET', `/panes/${encodeURIComponent(id)}/buffer?lines=${lines}`);
      return res.content;
    },
    readRawBuffer: async (id, lines) => {
      const res = await call<{ data: number[] }>('GET', `/panes/${encodeURIComponent(id)}/raw?lines=${lines}`);
      return res.data;
    },
    readScreen: async (id) => {
      const res = await call<{ b64: string; cols: number; rows: number; offset?: number }>(
        'GET',
        `/panes/${encodeURIComponent(id)}/screen`,
      );
      // `offset`: where in the pane's byte stream the screen was taken (absent from older backends).
      return { data: decodeBase64(res.b64), cols: res.cols, rows: res.rows, ...streamOffset(res.offset) };
    },
    readSnapshot: async (id) => {
      const res = await call<{ content: string }>('GET', `/panes/${encodeURIComponent(id)}/snapshot`);
      return res.content;
    },
    listAgentContexts: () => call('GET', '/agent-contexts'),
    readAgentContext: async (args) => {
      if (args.pane_id) {
        return call('GET', `/panes/${encodeURIComponent(args.pane_id)}/agent-context`);
      }
      const contexts = await call<Array<AgentContextProfile & { agent_type: string }>>('GET', '/agent-contexts');
      const context = contexts.find((candidate) => candidate.agent_type === args.agent_type);
      if (!context) throw new Error(`unknown agent_type: ${args.agent_type}`);
      return context;
    },
    inspectAgentModel: (id, lines = 200) =>
      call('GET', `/panes/${encodeURIComponent(id)}/model?lines=${lines}`),
    switchAgentModel: (id, args) =>
      call('POST', `/panes/${encodeURIComponent(id)}/model`, args),
    writeInput: (id, text, appendNewline = true, options) =>
      call('POST', `/panes/${encodeURIComponent(id)}/input`, {
        text,
        append_newline: appendNewline,
        via_opencode_api: options?.viaOpencodeApi ?? false,
        ...(options?.modelProvider ? { model_provider: options.modelProvider } : {}),
        ...(options?.modelId ? { model_id: options.modelId } : {}),
      }),
    resize: (id, cols, rows) =>
      call('POST', `/panes/${encodeURIComponent(id)}/resize`, { cols, rows }),
    getWorkspaceState: () => call('GET', '/workspace/state'),
    listMcpTools: () => call('GET', '/mcp/tools'),
    listMcpResources: () => call('GET', '/mcp/resources'),
    listMcpPrompts: () => call('GET', '/mcp/prompts'),
    listTasks: () => call('GET', '/tasks'),
    createTask: (args) => call('POST', '/tasks', args),
    claimTask: (taskId, args) => call('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, args),
    patchTaskStatus: (taskId, args) => call('POST', `/tasks/${encodeURIComponent(taskId)}/status`, args),
    completeTask: (taskId, args) => call('POST', `/tasks/${encodeURIComponent(taskId)}/complete`, args),
    blockTask: (taskId, args) => call('POST', `/tasks/${encodeURIComponent(taskId)}/block`, args),
    listLocks: () => call('GET', '/locks'),
    acquireResourceLock: (args) => call('POST', '/locks', args),
    releaseResourceLock: (args) => call('POST', '/locks/release', args),
    getAudit: () => call('GET', '/audit'),
    readSessionContext: () => call('GET', '/session/context'),
    updateSessionContext: (patch) => call('PATCH', '/session/context', patch),
    setPaneRole: (paneId, role) =>
      call('POST', `/panes/${encodeURIComponent(paneId)}/role`, { role }),
    readPaneDigest: (paneId) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/digest`),
    updatePaneDigest: (args) =>
      call('POST', `/panes/${encodeURIComponent(args.pane_id)}/digest`, args),
    delegateTask: (args) => call('POST', '/delegate-task', args),
    readOrchestratorState: () => call('GET', '/orchestrator/state'),
    updateOrchestratorState: (patch) => call('PATCH', '/orchestrator/state', patch),
    buildContextPack: (args) => call('POST', '/context-packs', args),
    readProjectIrStatus: () => call('GET', '/project-ir/status'),
    readLibrarianPrompt: () => call('GET', '/librarian/prompt'),
    waitForPanes: (args) => call('POST', '/panes/wait', args),
    waitForModel: (args) => call('POST', '/panes/wait/model', args),
    waitForTask: (args) => call('POST', '/panes/wait/task', args),
    readRecentEvents: (args = {}) => {
      const params = new URLSearchParams();
      if (args.limit != null) params.set('limit', String(args.limit));
      if (args.pane_id) params.set('pane_id', args.pane_id);
      if (args.since_id) params.set('since_id', args.since_id);
      if (args.types?.length) params.set('types', args.types.join(','));
      const query = params.toString();
      return call('GET', `/events/recent${query ? `?${query}` : ''}`);
    },
    readOpencodeWorkerStatus: (paneId) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/opencode/status`),
    readOpencodeMessages: (paneId, args) => {
      const params = new URLSearchParams();
      if (args?.limit != null) params.set('limit', String(args.limit));
      if (args?.role) params.set('role', args.role);
      const query = params.toString();
      return call(
        'GET',
        `/panes/${encodeURIComponent(paneId)}/opencode/messages${query ? `?${query}` : ''}`,
      );
    },
    replyOpencodePermission: (paneId, requestId, reply) =>
      call('POST', `/panes/${encodeURIComponent(paneId)}/opencode/permissions/${encodeURIComponent(requestId)}/reply`, {
        reply,
      }),
    replyOpencodeQuestion: (paneId, args) =>
      call('POST', `/panes/${encodeURIComponent(paneId)}/opencode/question/reply`, args),
    getSettings: () => call('GET', '/settings'),
    pairMe: () => call('GET', '/pair/me'),
    paneChat: (paneId, since) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/chat${since === undefined ? '' : `?since=${since}`}`),
    paneChatEarlier: (paneId, before, limit) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/chat/earlier?before=${encodeURIComponent(before)}${limit === undefined ? '' : `&limit=${limit}`}`),
    panePicture: (paneId, path) => call('GET', `/panes/${encodeURIComponent(paneId)}/picture?path=${encodeURIComponent(path)}`),
    paneDraft: (paneId) => call('GET', `/panes/${encodeURIComponent(paneId)}/draft`),
    setPaneDraft: (paneId, text) => call('POST', `/panes/${encodeURIComponent(paneId)}/draft`, { text }),
    acpSession: (paneId) => call('GET', `/acp/sessions/${encodeURIComponent(paneId)}`),
    acpTyping: (paneId) => call('POST', `/acp/sessions/${encodeURIComponent(paneId)}/typing`, {}),
    acpClaim: (paneId) => call('POST', `/acp/sessions/${encodeURIComponent(paneId)}/claim`, {}),
    deviceNames: async () => (await call<{ names?: Record<string, { name: string; kind: string }> }>('GET', '/devices/names')).names ?? {},
    tellName: (name) => call('POST', '/pair/me', { name }),
    acpCancel: (paneId) => call('POST', `/acp/sessions/${encodeURIComponent(paneId)}/cancel`, {}),
    phoneNewChat: () => call('GET', '/phone/new-chat'),
    phoneModelOptions: (agent) => call('GET', `/phone/new-chat/models?agent=${encodeURIComponent(agent)}`),
    phoneStartChat: (args) => call('POST', '/phone/chats', args),
    phoneWarm: (args) => call('POST', '/phone/warm', args),
    acpSetConfig: (paneId, optionId, value, hold) =>
      call('POST', `/acp/sessions/${encodeURIComponent(paneId)}/config`, { option_id: optionId, value, ...(hold ? { hold: true } : {}) }),
    acpClosed: async () => (await call<{ chats?: PhoneClosedChat[] }>('GET', '/acp/closed')).chats ?? [],
    acpReopen: (id) => call('POST', `/acp/closed/${encodeURIComponent(id)}/reopen`, {}),
    searchChats: (query, limit) => {
      const params = new URLSearchParams({ q: query });
      if (limit != null) params.set('limit', String(limit));
      return call('GET', `/chats/search?${params.toString()}`);
    },
    sendPaneMessage: async (paneId, text, attachments) =>
      (
        await call<{ message: OutboxMessage }>(
          'POST',
          `/panes/${encodeURIComponent(paneId)}/messages`,
          attachments && attachments.length > 0 ? { text, attachments } : { text },
        )
      ).message,
    uploadPaneFile: async (paneId, body) =>
      (await call<{ attachment: ChatAttachment }>('POST', `/panes/${encodeURIComponent(paneId)}/uploads`, body)).attachment,
    paneArtifact: (paneId, id, version) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/artifacts/${encodeURIComponent(id)}${version ? `?v=${version}` : ''}`),
    shareArtifact: (paneId, id, version, ttlHours) =>
      call('POST', `/panes/${encodeURIComponent(paneId)}/artifacts/${encodeURIComponent(id)}/share`, { version, ...(ttlHours ? { ttlHours } : {}) }),
    paneResult: (paneId, withPatch) =>
      call('GET', `/panes/${encodeURIComponent(paneId)}/result${withPatch ? '?patch=1' : ''}`),
    cancelPaneMessage: async (paneId, messageId) =>
      (
        await call<{ message: OutboxMessage }>(
          'DELETE',
          `/panes/${encodeURIComponent(paneId)}/messages/${encodeURIComponent(messageId)}`,
        )
      ).message,
    holdPaneMessage: async (paneId, messageId, hold) =>
      (
        await call<{ message: OutboxMessage }>(
          'POST',
          `/panes/${encodeURIComponent(paneId)}/messages/${encodeURIComponent(messageId)}/hold`,
          { hold },
        )
      ).message,
    editPaneMessage: async (paneId, messageId, text) =>
      (
        await call<{ message: OutboxMessage }>(
          'POST',
          `/panes/${encodeURIComponent(paneId)}/messages/${encodeURIComponent(messageId)}/edit`,
          { text },
        )
      ).message,
    listPaneMessages: async (paneId) =>
      (await call<{ messages: OutboxMessage[] | null }>('GET', `/panes/${encodeURIComponent(paneId)}/messages`)).messages ?? [],
    companionList: async () => (await call<{ companions: CompanionView[] }>('GET', '/companions')).companions ?? [],
    companionGet: (id) => call('GET', `/companions/${encodeURIComponent(id)}`),
    companionFeed: async (id, sinceMs) =>
      (await call<{ items: FeedItem[] }>('GET', `/companions/${encodeURIComponent(id)}/feed?since=${sinceMs}`)).items ?? [],
    companionMemory: (id) => call('GET', `/companions/${encodeURIComponent(id)}/memory`),
    companionDecidePending: (id, itemId, decision) =>
      call('POST', `/companions/${encodeURIComponent(id)}/memory/pending/${encodeURIComponent(itemId)}`, { decision }),
    companionWake: (id) => call('POST', `/companions/${encodeURIComponent(id)}/wake`, {}),
    companionSleep: (id) => call('POST', `/companions/${encodeURIComponent(id)}/sleep`, {}),
    plansReport: (month) => call('GET', `/plans${month ? `?month=${encodeURIComponent(month)}` : ''}`),
    timelineDay: (date) => call('GET', `/timeline/${encodeURIComponent(date)}`),
    timelinePointDiff: async (p) => (await call<{ changes: import('./timeline').PointFile[] }>('GET', `/timeline/point/diff?${pointQuery(p)}`)).changes ?? [],
    timelineNowDiff: (p) => call('GET', `/timeline/point/now-diff?${pointQuery(p)}`),
    timelinePatch: (p, path, side) => call('GET', `/timeline/point/patch?${pointQuery(p)}&path=${encodeURIComponent(path)}&side=${side}`),
    timelineGoBack: (p) => call('POST', '/timeline/point/restore', { project: p.project, key: p.key, id: p.id }),
    patchSettings: (patch) => call('PATCH', '/settings', patch),
  };
}

/**
 * Poll the bridge /panes endpoint until it responds. Used on startup to
 * discover the bridge URL (the GUI writes the port file, the bridge
 * listens — we just need to find it).
 *
 * This walks Potato Workspace's own port range (17421–17499) trying GET /health on
 * each port. Returns the first responding base URL.
 */
export async function findBridgeUrl(): Promise<string | null> {
  // A second Potato Workspace on this computer (POTATO_WORKSPACE_PROFILE) must reach its own bridge,
  // never the first one that answers. The default profile gets null and scans as before.
  const own = await profileBridgeUrl();
  if (own) return own;
  for (let p = BRIDGE_PORT_MIN; p <= BRIDGE_PORT_MAX; p++) {
    try {
      const res = await fetch(`http://${DEFAULT_POLL_HOST}:${p}/health`, {
        signal: AbortSignal.timeout(200),
      });
      if (res.ok) {
        return `http://${DEFAULT_POLL_HOST}:${p}`;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function profileBridgeUrl(): Promise<string | null> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
  try {
    return (await invoke<string | null>('profile_bridge_url')) ?? null;
  } catch {
    return null;
  }
}

export { DEFAULT_POLL_HOST, DEFAULT_POLL_INTERVAL_MS };

/** The query of a Today point: the folder, the series and the save point. */
function pointQuery(p: { project: string; key: string; id: string }): string {
  return `project=${encodeURIComponent(p.project)}&key=${encodeURIComponent(p.key)}&id=${encodeURIComponent(p.id)}`;
}
