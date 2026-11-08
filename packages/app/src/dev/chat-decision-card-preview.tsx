import { DecisionCard } from '../components/chat/DecisionCard';
import { SessionChatView } from '../components/chat/SessionChatView';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';
import type { Question } from '../lib/questions';

// The chat's decision card, the quiet permission lines, a folded thought and the row under a reply, drawn over the cockpit.
const items: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'Clean the build folder and run the tests' },
  { kind: 'thinking', id: 'th1', at: null, text: 'The build output is in dist. I should remove it first, then run the test script.', durationMs: 6000 },
  { kind: 'notice', id: 'perm:1', at: null, noticeKind: 'permission', text: 'Allowed · Select-String -Path brain.mjs' },
  { kind: 'notice', id: 'perm:2', at: null, noticeKind: 'permission', text: "Allowed automatically (you said don't ask again) · npm test" },
  { kind: 'notice', id: 'perm:3', at: null, noticeKind: 'permission', text: 'Denied · Delete 3 files in dist/' },
  { kind: 'assistant', id: 'a1', at: null, text: 'I left dist/ alone and ran the tests: all 42 passed.', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 21000 },
  { kind: 'user', id: 'u2', at: null, text: 'Now tidy the logs' },
  { kind: 'thinking', id: 'th2', at: null, text: 'Looking for old log files to remove' },
];

const ask = (id: string, text: string): Question => ({
  id,
  question: `Agent asks permission: ${text}`,
  choices: [
    { id: 'allow_once', label: 'Allow Once' },
    { id: 'allow_always', label: 'Allow for Session' },
    { id: 'reject_once', label: 'Reject' },
  ],
  allow_free_text: false,
  urgency: 'high',
  created_at_ms: 1,
  expires_at_ms: 99,
  state: 'pending',
  kind: 'acp_permission',
  pane_id: 'p1',
});

const permission = (toolKind: string, title: string, questionId: string) => ({
  askId: 1,
  title,
  toolKind,
  questionId,
  sinceMs: 0,
  options: [
    { id: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
    { id: 'allow_always', name: 'Allow for Session', kind: 'allow_always' },
    { id: 'reject_once', name: 'Reject', kind: 'reject_once' },
  ],
});

export function Preview() {
  const run = permission('execute', 'Select-String -Path "C:\\Program Files\\Potato Bot\\resources\\brain.mjs" -Pattern "workspace" -SimpleMatch', 'q1');
  const risky = permission('delete', 'Delete 3 files in dist/', 'q2');
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <style>{'.ck-acts{opacity:1!important}'}</style>
      <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ height: 380, border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
          <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items).turns} model="Agent" cliVersion={null} paneId={null} />
        </div>
        <DecisionCard q={ask('q1', 'Run command')} permission={run} label="Agent" waiting={1} canRememberHere onAnswer={() => undefined} onDismiss={() => undefined} />
        <DecisionCard q={ask('q2', 'Delete 3 files in dist/')} permission={risky} label="Agent" waiting={0} canRememberHere onAnswer={() => undefined} onDismiss={() => undefined} />
        <div className="ck-dc-auto" style={{ padding: 0 }}>
          <span>Not asking for: Run command</span>
          <span aria-hidden="true"> · </span>
          <button type="button" className="ck-dc-more">
            Turn back on
          </button>
        </div>
      </div>
    </div>
  );
}

