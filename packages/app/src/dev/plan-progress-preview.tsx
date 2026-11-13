import { useState, type FC } from 'react';
import { PendingMessages } from '../components/chat/PendingMessages';
import { PlanBar } from '../components/chat/PlanBar';
import { PlanLine } from '../components/common/PlanLine';
import { planProgress, publishPlanProgress } from '../lib/planProgress';
import type { OutboxMessage } from '../lib/paneOutbox';
import type { PlanItem } from '../lib/sessionChatModel';

// Dev only: the plan bar at the top of a chat, a sidebar row with its thin line, and two waiting messages with Edit and
// Remove (a small in-memory queue: Edit holds, Save keeps the place).
const PLAN: PlanItem[] = [
  { text: 'Read the bridge routes', status: 'completed' },
  { text: 'Add the loopback check', status: 'completed' },
  { text: 'Write the tests', status: 'completed' },
  { text: 'Run the full test suite', status: 'in_progress' },
  { text: 'Fix anything that fails', status: 'pending' },
  { text: 'Write the summary', status: 'pending' },
];
const PANE = 'preview-plan-pane';
publishPlanProgress(PANE, planProgress(PLAN));

const queued = (id: string, text: string, waitingFor: string): OutboxMessage => ({ id, text, createdAt: 1, state: 'queued', waitingFor, error: null });

export const Preview: FC = () => {
  const [messages, setMessages] = useState<OutboxMessage[]>([
    queued('m1', 'Also update the changelog when you are done.', 'The agent is working. Sends when the turn ends.'),
    queued('m2', 'Then open a pull request.', 'Waits for the messages before it.'),
  ]);
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', background: 'var(--bg)', color: 'var(--label)' }}>
      <aside style={{ width: 240, padding: 12, borderRight: '1px solid var(--sep)' }}>
        <div className="ck-row ck-row--slim is-active" style={{ display: 'flex' }}>
          <span className="ck-row-main">
            <span className="ck-row-title">Fix login redirect</span>
            <PlanLine paneId={PANE} />
          </span>
        </div>
      </aside>
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--sep)', fontWeight: 600 }}>Fix login redirect</div>
        <PlanBar items={PLAN} />
        <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
          <p style={{ color: 'var(--label-2)' }}>I will read the routes first, then run the checks.</p>
        </div>
        <div style={{ padding: 12 }}>
          <PendingMessages
            messages={messages}
            onCancel={async (id) => {
              setMessages((list) => list.filter((m) => m.id !== id));
              return null;
            }}
            onHold={async () => null}
            onEdit={async (id, text) => {
              setMessages((list) => list.map((m) => (m.id === id ? { ...m, text } : m)));
              return null;
            }}
            onHide={() => undefined}
          />
        </div>
      </main>
    </div>
  );
};
