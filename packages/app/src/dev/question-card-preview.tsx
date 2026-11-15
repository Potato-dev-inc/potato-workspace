import { ToolRow } from '../components/chat/ToolRow';
import { ChatAnswerContext } from '../components/chat/chatAnswer';
import type { ToolStep } from '../lib/sessionChatModel';

// An agent's `question` tool call as a card with options (one pick, and several picks), real components and CSS.
const call = (id: string, input: unknown): ToolStep => ({
  kind: 'tool',
  id,
  call: { kind: 'toolCall', id, at: null, callId: id, name: 'question', summary: 'question', input },
  result: null,
  status: 'error',
});

const ONE = call('q1', { questions: [{ header: 'Style', question: 'Which style should the page use?', options: [{ label: 'Plain', description: 'Black on white, no colour' }, { label: 'Warm', description: 'Soft orange accents' }, { label: 'Bold', description: 'Big type, strong contrast' }] }] });
const MANY = call('q2', { questions: [{ header: 'Pages', question: 'Which pages do you want?', multiple: true, options: [{ label: 'Home' }, { label: 'About' }, { label: 'Contact' }] }] });

export function Preview() {
  return (
    <ChatAnswerContext.Provider value={async () => null}>
      <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 9999, maxWidth: 'none', padding: 24, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--bg, #fff)', overflow: 'auto' }}>
        <ToolRow step={ONE} fromScreen={false} />
        <ToolRow step={MANY} fromScreen={false} />
      </div>
    </ChatAnswerContext.Provider>
  );
}
