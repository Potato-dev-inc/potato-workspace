// Harness (route `phone`): stands in for the PC's bridge. Replaces fetch for the fake bridge origin
// and EventSource, so the real PwaApp runs in a plain browser. The network stays blocked otherwise.
import { PHONE_AGENT_TYPES, PHONE_BUFFER, PHONE_DIGEST, PHONE_PANES, PHONE_PREVIEWS, PHONE_QUESTION, PHONE_SCREEN_LINES } from './phone-fixtures';
import { DEFAULT_PUBLIC_SETTINGS } from '../lib/bridge-settings';
import { LS_BRIDGE_URL } from '../lib/bridge-url';
import { PANE_CODEX } from './fixtures';
import { PHONE_ASKING_REPLY, PHONE_CHAT_REPLY, PHONE_QUEUED_MESSAGES, phoneLiveReply, phonePlanReply } from './phone-chat-fixtures';
import { phoneRichReply } from './phone-chat-rich-fixture';
import { PHONE_TEAM_JOB, PHONE_TEAM_OFF, phoneTeamReply } from './phone-team-fixtures';
import type { HarnessScenario } from './types';

export const MOCK_BRIDGE_URL = 'http://127.0.0.1:17421/bridge';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Cards and jobs the example phone removed this page load (the harness has no real PC behind it). */
const gone = new Set<string>();

/** The `/team/*` routes; null when the path is not one of them. */
function teamRoute(method: string, route: string, scenario: HarnessScenario): Response | null {
  const team = scenario.phone?.team;
  if (route === '/team/cards' && method === 'GET') {
    if (!team) return json(PHONE_TEAM_OFF);
    const reply = phoneTeamReply(team);
    return json({ ...reply, cards: reply.cards.filter((c) => !gone.has(c.id)), jobs: reply.jobs.filter((j) => !gone.has(j.id)) });
  }
  const act = /^\/team\/(cards|jobs)\/([^/]+)\/(dismiss|pull|queue|apply|discard)$/.exec(route);
  if (!act || method !== 'POST') return null;
  if (!team) return json({ error: 'not_allowed' }, 403);
  const [, , id, verb] = act;
  if (verb === 'pull') return json({ ok: true, result: 'Pulled feat/invoices into feat/billing.' });
  if (verb === 'queue') return json({ ok: true, result: { ...PHONE_TEAM_JOB, id: 'job-queued', state: 'waiting' } });
  if (verb === 'apply') {
    gone.add(id);
    return json({ ok: true, result: 'feat/billing is now up to date.' });
  }
  gone.add(id);
  return json({ ok: true });
}

/** Answer one bridge request, or null for an unknown route. */
function answer(method: string, path: string, scenario: HarnessScenario): Response | null {
  const phone = scenario.phone ?? {};
  const route = path.split('?')[0];
  const pane = /^\/panes\/([^/]+)\/(buffer|screen|raw|viewport)$/.exec(route);
  if (route === '/health') return json({ ok: true });
  if (route.startsWith('/team/')) return teamRoute(method, route, scenario);
  if (route === '/panes' && method === 'GET') return json(scenario.phonePanes ?? PHONE_PANES);
  if (route === '/pair/me') {
    return json({ local: false, device_id: 'harness-phone', caps: scenario.phoneCaps ?? ['watch', 'answer', 'type', 'control'] });
  }
  if (route === '/previews') return json({ previews: PHONE_PREVIEWS });
  if (route === '/settings') return json({ ...DEFAULT_PUBLIC_SETTINGS });
  if (route === '/attention' && method === 'GET' && phone.attention) {
    const { blocking, ready = 0, items, device } = phone.attention;
    const open = items?.filter((i) => i.state === 'open') ?? [];
    const counts = items
      ? { blocking: open.filter((i) => i.lane === 'blocking').length, ready: open.filter((i) => i.lane === 'ready').length }
      : { blocking, ready };
    return json({ v: 1, rev: 1, counts, items: items ?? [], device: device ?? { can_answer: true, can_type: true, can_control: true } });
  }
  const answerRoute = /^\/attention\/([^/]+)\/answer$/.exec(route);
  if (answerRoute && method === 'POST' && phone.attention) {
    const mode = phone.attention.answer ?? 'answered';
    if (mode === 'hang') return new Promise<Response>(() => {}) as unknown as Response;
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    const outcome = {
      answered: { outcome: 'answered', choice_label: 'Allowed once', at_ms: Date.now() },
      changed: { outcome: 'changed' },
      gone: { outcome: 'gone', reason: 'moved_on' },
      already_pc: { outcome: 'already_answered', by: 'pc', choice_label: 'Allowed once' },
      failed: { outcome: 'failed', code: 'PROMPT_REPLY_FAILED' },
    }[mode];
    return json(outcome);
  }
  if (route === '/questions') return json({ questions: phone.questions === false ? [] : (phone.questionList ?? [PHONE_QUESTION]) });
  if (route === '/digest') return json(phone.digest === false ? { ...PHONE_DIGEST, empty: true } : PHONE_DIGEST);
  if (route === '/agents/types') return json(PHONE_AGENT_TYPES);
  const chatRoute = /^\/panes\/([^/]+)\/chat$/.exec(route);
  if (chatRoute && method === 'GET') {
    const served = phone.chat === 'rich' ? phoneRichReply(Date.now()) : phone.chat === 'plan' ? phonePlanReply(Date.now()) : phone.chat === 'live' ? phoneLiveReply(Date.now()) : phone.chat === 'asking' ? PHONE_ASKING_REPLY : PHONE_CHAT_REPLY;
    return json(path.includes('since=') ? { ...served, items: [] } : served);
  }
  // Phone compose: what the last turn did (P10) and a file sent from the phone (P14).
  if (/^\/panes\/[^/]+\/result$/.test(route) && method === 'GET') {
    const withPatch = path.includes('patch=1');
    return json({
      available: true,
      turn: 1,
      sentence: 'Claude edited 2 files (+48 \u221212), now idle.',
      agent: 'Claude',
      durationMs: 252_000,
      files: { count: 2, added: 48, deleted: 12, paths: ['src/pages/Login.tsx', 'src/session.ts'] },
      tests: 'all checks passed (3/3)',
      failed: false,
      changes: [
        { path: 'src/pages/Login.tsx', status: 'M', added: 30, deleted: 8, binary: false },
        { path: 'src/session.ts', status: 'M', added: 18, deleted: 4, binary: false },
      ],
      ...(withPatch
        ? {
            patch:
              'diff --git a/src/pages/Login.tsx b/src/pages/Login.tsx\n--- a/src/pages/Login.tsx\n+++ b/src/pages/Login.tsx\n@@ -12,7 +12,8 @@\n   const target = readTarget();\n-  navigate(target);\n-  saveSession(user);\n+  saveSession(user);\n+  navigate(target);\n   return null;\n',
            patchCut: false,
          }
        : {}),
    });
  }
  if (/^\/panes\/[^/]+\/uploads$/.test(route) && method === 'POST') {
    return json({ attachment: { name: 'photo.jpg', path: 'C:/Potato/phone-uploads/2026-11-13/photo.jpg', kind: 'image', size: 1_258_291, mime: 'image/jpeg' } });
  }
  if (/^\/panes\/[^/]+\/messages$/.test(route) && method === 'GET') return json({ messages: phone.chat === 'plan' ? PHONE_QUEUED_MESSAGES : [] });
  const acpState = /^\/acp\/sessions\/([^/]+)$/.exec(route);
  if (acpState && method === 'GET' && phone.acp) {
    const busy = phone.acp.busy === true;
    return json({
      lane: 'acp', agent: 'codex', label: 'Codex', phase: busy ? 'working' : 'idle', status: busy ? 'running' : 'idle', turnInFlight: busy,
      stopping: false, canSteer: false, turn: 1, title: null, usage: null, permissions: [], closed: false, configOptions: phone.acp.configOptions ?? [],
    });
  }
  if (route === '/phone/new-chat' && method === 'GET' && phone.acp?.newChat) return json(phone.acp.newChat);
  if (route === '/acp/closed' && method === 'GET' && phone.acp) return json({ chats: phone.acp.closed ?? [] });
  if (route === '/pane-rules' && method === 'GET') return json({ rules: phone.rules ?? {} });
  if (/^\/panes\/[^/]+\/interrupt$/.test(route) && method === 'POST') return json({ pane_id: route.split('/')[2], stopped: true });
  if (route === '/control-asks' && method === 'POST') return json({ asked: true, id: 'ask-harness' }, 202);
  if (route === '/panes/stop-all') return json({ stopped: [{ pane_id: PANE_CODEX, agent_type: 'codex', cwd: '' }], failed: [] });
  if (pane) {
    const [, id, kind] = pane;
    if (kind === 'buffer') return json({ content: PHONE_BUFFER[id] ?? '' });
    if (kind === 'screen') {
      const bytes = new TextEncoder().encode(PHONE_SCREEN_LINES.join('\r\n'));
      return json({ b64: b64(bytes), cols: 44, rows: 30 });
    }
    if (kind === 'raw') return json({ data: [] });
    return json({ ok: true, leased: true, held: true, cols: 44, rows: 30 });
  }
  return null;
}

/** An event stream that stays open and delivers the scenario's events once. */
class MockEventSource extends EventTarget {
  readyState = 1;
  url: string;
  static pending: { name: string; data: unknown }[] = [];
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    window.setTimeout(() => {
      this.dispatchEvent(new Event('open'));
      for (const ev of MockEventSource.pending) {
        this.dispatchEvent(new MessageEvent(ev.name, { data: JSON.stringify(ev.data) }));
      }
    }, 50);
  }
  close() {
    this.readyState = 2;
  }
}

export function installMockBridge(scenario: HarnessScenario): void {
  const blocked = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith(MOCK_BRIDGE_URL)) {
      const method = (init?.method ?? 'GET').toUpperCase();
      return answer(method, href.slice(MOCK_BRIDGE_URL.length), scenario) ?? json({ error: 'harness: not mocked' }, 404);
    }
    return blocked(input, init);
  };
  MockEventSource.pending = scenario.phone?.events ?? [];
  window.EventSource = MockEventSource as unknown as typeof EventSource;
  try {
    localStorage.setItem(LS_BRIDGE_URL, MOCK_BRIDGE_URL);
    if (scenario.phone?.activeTab) localStorage.setItem('pm.mobile.activeTab', scenario.phone.activeTab);
    else localStorage.removeItem('pm.mobile.activeTab');
    if (scenario.phone?.setup) localStorage.setItem('pm.phone.setup', 'pending');
    else localStorage.setItem('pm.phone.setup', 'done');
  } catch {
    /* storage unavailable */
  }
  const ua = scenario.phone?.userAgent;
  if (ua) Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
}
