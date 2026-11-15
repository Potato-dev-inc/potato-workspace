// The phone chat the founder saw break: a permission "Allowed" line, two artifact cards, folded steps and a final answer; plus
// two pages to open (one that fills its width, one with a fixed 1000 px width of its own).
import type { ChatItem, PhoneChatReply } from '../lib/sessionChatModel';

export function phoneRenderReply(now: number): PhoneChatReply {
  const t = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', at: t(90), text: 'create a potato workspace overview page' },
    { kind: 'thinking', id: 't1', at: t(88), text: 'I will read the project, then make a page.', durationMs: 3000 },
    { kind: 'toolCall', id: 'c1', at: t(80), callId: 'k1', name: 'Read', summary: 'README.md', paths: ['README.md'] },
    { kind: 'toolResult', id: 'r1', at: t(79), callId: 'k1', ok: true, output: 'ok' },
    { kind: 'toolCall', id: 'c2', at: t(70), callId: 'k2', name: 'Read', summary: 'docs/FEATURES.md', paths: ['docs/FEATURES.md'] },
    { kind: 'toolResult', id: 'r2', at: t(69), callId: 'k2', ok: true, output: 'ok' },
    { kind: 'notice', id: 'n1', at: t(60), noticeKind: 'permission', text: 'Allowed · mcp__potato-workspace__show_artifact' },
    { kind: 'notice', id: 'n2', at: t(55), noticeKind: 'artifact', text: 'Overview page', url: 'potato-artifact:overview/1/html' },
    { kind: 'notice', id: 'n3', at: t(54), noticeKind: 'artifact', text: 'Fixed width page', url: 'potato-artifact:fixed/1/html' },
    { kind: 'assistant', id: 'a1', at: t(50), text: 'I made the page. Tap the card to open it.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e1', at: t(45), outcome: 'completed', durationMs: 45_000 },
  ];
  return { available: true, reason: null, source: 'file', waitingFor: null, rev: 1, reset: false, items };
}

const FLUID = '<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px system-ui"><div style="width:100%;background:#e8f0ff;padding:16px;box-sizing:border-box"><h1>Overview</h1><p>This block uses width 100%. It should reach both edges of the phone.</p></div><div style="border-right:6px solid #c33;height:200px"></div>';
const FIXED = '<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px system-ui"><div style="width:1000px;background:#efe;padding:16px;box-sizing:border-box;border-right:6px solid #393"><h1>Fixed 1000 px page</h1><p>This page has its own fixed width. The phone shows it scaled to fit, with no blank band.</p></div>';

export function phoneRenderArtifact(id: string) {
  const fixed = id === 'fixed';
  return {
    id,
    title: fixed ? 'Fixed width page' : 'Overview page',
    kind: 'html',
    latest: 1,
    version: 1,
    versions: [{ n: 1, at: new Date().toISOString(), bytes: 400 }],
    updatedAt: new Date().toISOString(),
    content: fixed ? FIXED : FLUID,
  };
}

/** The companion the founder saw (Mochi on OpenCode): a long "while you were away" list and a chat read off the screen. */
export function phoneCompanionView() {
  return {
    id: 'mochi', name: 'Mochi', avatar: 'mochi', persona: 'calm', agentType: 'opencode', agentLabel: 'OpenCode', folderName: 'proj',
    state: 'idle', stateLine: 'Here. Ask me anything.', paneId: 'companion-mochi', needs: null, pendingMemory: 0,
    nextCheckin: { label: 'Morning look', atMs: Date.now() + 3_600_000 }, restarts: 0, autoStart: true,
  };
}

export function phoneCompanionFeed() {
  const now = Date.now();
  return [
    { id: 'f1', atMs: now - 9 * 60_000, kind: 'note', text: 'OpenCode made no file changes, now idle.' },
    { id: 'f2', atMs: now - 10 * 60_000, kind: 'note', text: 'Woke up.' },
    { id: 'f3', atMs: now - 45 * 60_000, kind: 'note', text: 'You closed its terminal, so it went to sleep.' },
    { id: 'f4', atMs: now - 50 * 60_000, kind: 'note', text: 'Read the project notes.' },
  ];
}

export function phoneCompanionChat(): PhoneChatReply {
  return { available: true, reason: null, source: 'screen', waitingFor: null, rev: 1, reset: false, items: [] };
}
