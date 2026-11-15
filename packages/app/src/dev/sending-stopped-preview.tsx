import { PendingMessages } from '../components/chat/PendingMessages';
import type { OutboxMessage } from '../lib/paneOutbox';

// The chat's waiting list when the sending worker stopped: the message says "Sending stopped" with Try again (real component and CSS).
const MESSAGES: OutboxMessage[] = [
  { id: 'm1', text: 'Fix the login test and run it again', createdAt: 1, state: 'failed', waitingFor: null, error: 'Sending stopped. Try again.', noAnswer: false },
  { id: 'm2', text: 'Then update the changelog', createdAt: 2, state: 'failed', waitingFor: null, error: 'The pane was closed.', noAnswer: false },
];

export function Preview() {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 9999, maxWidth: 'none', padding: 24, background: 'var(--bg, #fff)', overflow: 'auto' }}>
      <PendingMessages messages={MESSAGES} onCancel={async () => null} onHide={() => undefined} onRetry={async () => null} />
    </div>
  );
}
