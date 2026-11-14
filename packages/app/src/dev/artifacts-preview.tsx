import { ChatComposer } from '../components/chat/ChatComposer';
import { SessionChatView } from '../components/chat/SessionChatView';
import { ARTIFACT_NOTICE } from '../lib/artifacts';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';

// A chat where the agent made a page: the card sits under its answer. Dev evidence only.
const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: null, text: 'Can you show me which sign-in problems happen most?' },
  { kind: 'toolCall', id: 'c1', at: null, callId: 'k1', name: 'Read', summary: 'logs/signin.log', paths: ['logs/signin.log'] },
  { kind: 'toolResult', id: 'r1', at: null, callId: 'k1', ok: true, output: 'ok' },
  { kind: 'assistant', id: 'a1', at: null, text: 'The blank page after sign-in is the biggest one by far. I put the counts on a page so you can look at them.', model: null, finalAnswer: true },
  { kind: 'notice', id: 'artifact:signin-report:v1', at: null, noticeKind: ARTIFACT_NOTICE, text: 'Sign-in report', url: 'potato-artifact:signin-report/1/html' },
  { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 31_000 },
  { kind: 'user', id: 'u2', at: null, text: 'Nice. Add what you changed under the chart.' },
  { kind: 'assistant', id: 'a2', at: null, text: 'Done. The page now says what changed, and it is version 2.', model: null, finalAnswer: true },
  { kind: 'notice', id: 'artifact:signin-report:v2', at: null, noticeKind: ARTIFACT_NOTICE, text: 'Sign-in report', url: 'potato-artifact:signin-report/2/html' },
  { kind: 'turnEnd', id: 'e2', at: null, outcome: 'completed', durationMs: 12_000 },
];

export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
      <SessionChatView
        state="ready"
        reason={null}
        source="acp"
        turns={groupTurns(ITEMS).turns}
        model={null}
        cliVersion={null}
        paneId="artifact-preview"
        composer={<ChatComposer onSend={async () => null} blockedReason={null} />}
      />
    </div>
  );
}
