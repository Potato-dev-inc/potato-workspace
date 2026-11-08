import type { FC } from 'react';
import { AcpConfigChips } from '../components/chat/AcpConfigChips';
import { ChatComposer } from '../components/chat/ChatComposer';
import { PendingMessages } from '../components/chat/PendingMessages';
import { readContext } from '../components/cockpit/rail/railFormat';
import type { AcpChatState } from '../lib/acpChat';
import type { ChatAttachment } from '../lib/attachFiles';
import type { OutboxMessage } from '../lib/paneOutbox';

// The chat's message box as the agent's chat draws it: two queued messages above it, the draft with two attachment
// chips (an image and a file), the agent's settings on the footer toolbar (model, mode, effort) and the context ring.
export const COMPOSER_DRAFT_KEY = 'preview-composer';

export const COMPOSER_DRAFT_TEXT = 'The parser test fails on Windows line endings. Check the attached log and the screenshot of the failure.';

export const COMPOSER_ATTACHMENTS: ChatAttachment[] = [
  { name: 'parser-failure.png', path: 'C:\\Users\\dev\\work\\parser-failure.png', kind: 'image', size: 186_400, mime: 'image/png' },
  { name: 'ci-run.log', path: 'C:\\Users\\dev\\work\\ci-run.log', kind: 'file', size: 48_213, mime: 'text/plain' },
];

const now = Date.now();

const queued = (id: string, text: string, ageMs: number): OutboxMessage => ({
  id,
  text,
  createdAt: now - ageMs,
  state: 'queued',
  waitingFor: 'The agent is working.',
  error: null,
});

const PENDING: OutboxMessage[] = [
  queued('m1', 'Also check how the parser handles CRLF paths on Windows.', 90_000),
  queued('m2', 'Then run the full test suite and tell me the new count.', 30_000),
];

const STATE = {
  lane: 'acp',
  agent: 'Agent',
  label: 'Agent',
  phase: 'idle',
  status: 'idle',
  turnInFlight: false,
  stopping: false,
  canSteer: true,
  turn: 4,
  title: 'Parser line endings',
  usage: null,
  permissions: [],
  closed: false,
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'opus', name: 'Opus' },
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'haiku', name: 'Haiku' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        { value: 'ask', name: 'Ask before edits' },
        { value: 'auto', name: 'Auto edit' },
        { value: 'plan', name: 'Plan only' },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
} as unknown as AcpChatState;

const NOOP_API = { setConfig: async () => STATE };

// 124,000 of 200,000 tokens: 62 percent.
const CONTEXT = readContext({ kind: 'usage', id: 'u1', at: null, inputTokens: 98_000, outputTokens: 26_000, contextWindow: 200_000 });

export interface PreviewOptions {
  /** A key with no saved draft gives an empty box. */
  draftKey?: string;
  /** The agent works: the button is Stop and the footer says so. */
  running?: boolean;
  status?: { text: string; stopping: boolean } | null;
}

export const EMPTY_DRAFT_KEY = 'preview-composer-empty';

export const Preview: FC<PreviewOptions> = ({ draftKey = COMPOSER_DRAFT_KEY, running = false, status = null }) => {
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'block', background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100%', justifyContent: 'flex-end' }}>
        <PendingMessages messages={draftKey === EMPTY_DRAFT_KEY ? [] : PENDING} onCancel={async () => null} onHide={() => undefined} onSendNow={() => undefined} />
        <ChatComposer
          onSend={async () => null}
          blockedReason={null}
          draftKey={draftKey}
          running={running}
          onStop={running ? () => undefined : undefined}
          status={status}
          attachFiles={async () => []}
          toolbar={<AcpConfigChips paneId={COMPOSER_DRAFT_KEY} state={STATE} api={NOOP_API} />}
          contextUsage={CONTEXT}
        />
      </div>
    </div>
  );
};
