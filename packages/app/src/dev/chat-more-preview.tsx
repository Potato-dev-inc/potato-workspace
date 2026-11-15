import { SignInFixCard } from '../components/acp/SignInFixCard';
import { SessionChatView } from '../components/chat/SessionChatView';
import { ChatComposer } from '../components/chat/ChatComposer';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';

// Pictures in the chat, "Show earlier messages" and the sign-in card without a terminal, drawn over the cockpit.
// The picture comes from mock-tauri's `chat_picture` (a small chart drawn as a data URL).
const T0 = Date.UTC(2026, 10, 15, 1, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: at(0), text: 'Chart last month sales by week' },
  { kind: 'toolCall', id: 'c1', at: at(1), callId: 'k1', name: 'Write', summary: 'out/sales.png', paths: ['out/sales.png'], writes: true },
  { kind: 'toolResult', id: 'r1', at: at(1), callId: 'k1', ok: true, output: 'ok' },
  {
    kind: 'assistant',
    id: 'a1',
    at: at(2),
    text: 'Here is the chart. Week 3 was the best week.\n\n![Sales by week](<out/sales.png>)\n\nThe picture is saved in the project as out/sales.png.',
    model: null,
    finalAnswer: true,
  },
  { kind: 'turnEnd', id: 'e1', at: at(3), outcome: 'completed', durationMs: 41_000 },
];

export function PicturePreview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div style={{ width: 700, height: 600, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
        <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(ITEMS).turns} model="Agent" cliVersion={null} paneId="preview-picture" composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />
      </div>
    </div>
  );
}

export function EarlierPreview() {
  const earlier = { more: true, busy: false, failed: false, version: 0, show: () => undefined };
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div style={{ width: 700, height: 600, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
        <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(ITEMS.slice(0, 1).concat(ITEMS.slice(3))).turns} model="Agent" cliVersion={null} paneId="preview-earlier" earlier={earlier} composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />
      </div>
    </div>
  );
}

/** The sign-in card: step one (two steps), or the sign-in running with its terminal opened by a question. */
export function SignInPreview({ asking }: { asking: boolean }) {
  const driver = {
    start: async () => 'hidden-1',
    status: async () => ({ alive: true, asking, pane_id: 'hidden-1' }),
    stop: async () => undefined,
  };
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div style={{ width: 700, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <SignInFixCard
          label="Claude"
          kept="add the date format to the report"
          other={null}
          onOpen={async () => undefined}
          onRetry={async () => {
            throw new Error('still out');
          }}
          onUseOther={async () => undefined}
          signIn={driver}
          renderTerminal={() => (
            <pre className="lend-term" style={{ background: '#111', color: '#ddd', padding: 8, margin: 0, fontSize: 12, overflow: 'hidden' }}>
              {'Select login method:\n\n  1. Claude account with subscription\n  2. Anthropic Console account\n\n> '}
            </pre>
          )}
          lookMs={50}
        />
      </div>
    </div>
  );
}
