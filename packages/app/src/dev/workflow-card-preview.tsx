import { ChatComposer } from '../components/chat/ChatComposer';
import { SessionChatView } from '../components/chat/SessionChatView';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';
import { recordWorkflowStart, workflowFirstMessage } from '../lib/workflowCard';

// A chat that started from a workflow: one "Using workflow" card, then the person's words. Example data only.
const BRIEF = [
  'You are the front of the workflow "Research + Write". Read each request from the person, decide which helper fits, start that helper yourself, and report back. Work in this folder: D:/project',
  '',
  'Your rules:\nWrite the document the person asks for. A Researcher is collecting facts into research-notes.md in the same folder at the same time. Check that file from time to time and use what it says.',
  '',
  'Your helpers. Start one only when its "use for" fits the request. Do small things yourself.\n- Researcher - use for: Tasks that fit this agent.',
  '',
  'Limits:\n- Start at most 3 helper runs for each message from the person.\n- Do not let helpers start other helpers.',
  '',
].join('\n');

export function WorkflowCardPreview({ open }: { open: boolean }) {
  recordWorkflowStart('preview-wf', { name: 'Research + Write', brief: BRIEF });
  const items: ChatItem[] = [
    { kind: 'user', id: 'u1', at: null, text: workflowFirstMessage(BRIEF, 'hi') },
    { kind: 'assistant', id: 'a1', at: null, text: 'Hi! Tell me what document to write and I will start the Researcher if it helps.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: 'e1', at: null, outcome: 'completed', durationMs: 4000 },
  ];
  // The card is closed by default; the "open" picture clicks it once it is drawn.
  const click = (el: HTMLElement | null) => {
    if (open && el && !el.dataset.opened) {
      el.dataset.opened = '1';
      window.setTimeout(() => el.querySelector<HTMLElement>('[data-testid="workflow-card"] button')?.click(), 100);
    }
  };
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 16 }}>
      <div ref={click} style={{ width: '100%', maxWidth: 640, height: 520, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
        <SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items).turns} model="Agent" cliVersion={null} paneId="preview-wf" composer={<ChatComposer onSend={async () => null} blockedReason={null} />} />
      </div>
    </div>
  );
}
