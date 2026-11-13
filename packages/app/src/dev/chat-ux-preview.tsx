import { useEffect, useRef } from 'react';
import { ChatComposer } from '../components/chat/ChatComposer';
import { SessionChatView } from '../components/chat/SessionChatView';
import { writeSeen } from '../lib/chatSince';
import { groupTurns, type ChatItem } from '../lib/sessionChatModel';

// The chat extras of round 3, drawn over the cockpit: find in this chat, the price tag (and a heavy turn), the
// "New since you looked" line with its jump button, and "My messages".
const T0 = Date.UTC(2026, 10, 13, 1, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function turn(n: number, min: number, ask: string, reads: number, edits: number, answer: string, ms: number): ChatItem[] {
  const items: ChatItem[] = [{ kind: 'user', id: `u${n}`, at: at(min), text: ask }];
  for (let i = 0; i < reads; i++) {
    items.push({ kind: 'toolCall', id: `c${n}-${i}`, at: at(min + 1), callId: `k${n}-${i}`, name: 'Read', summary: `src/part${n}-${i}.ts`, paths: [`src/part${n}-${i}.ts`] });
    items.push({ kind: 'toolResult', id: `r${n}-${i}`, at: at(min + 1), callId: `k${n}-${i}`, ok: true, output: i === 0 ? 'export const invoiceTotal = 42;' : 'ok' });
  }
  for (let i = 0; i < edits; i++) {
    items.push({ kind: 'toolCall', id: `ce${n}-${i}`, at: at(min + 2), callId: `ke${n}-${i}`, name: 'Edit', summary: `src/Edit${n}-${i}.tsx`, paths: [`src/Edit${n}-${i}.tsx`], writes: true });
    items.push({ kind: 'toolResult', id: `re${n}-${i}`, at: at(min + 2), callId: `ke${n}-${i}`, ok: true, output: 'ok' });
  }
  items.push({ kind: 'assistant', id: `a${n}`, at: at(min + 3), text: answer, model: null, finalAnswer: true });
  items.push({ kind: 'turnEnd', id: `e${n}`, at: at(min + 4), outcome: 'completed', durationMs: ms });
  return items;
}

const ITEMS: ChatItem[] = [
  ...turn(1, 0, 'Add an invoice page', 3, 2, 'The invoice page is in. The invoice total reads from the order.', 95_000),
  ...turn(2, 20, 'Make the invoice header blue', 2, 1, 'Done: the invoice header is blue in both themes.', 48_000),
  ...turn(3, 40, 'Add the invoice footer', 4, 1, 'The footer shows the invoice date and a Print button.', 62_000),
  ...turn(4, 60, 'Why is the invoice slow to load?', 22, 0, 'The page loaded every order twice. I read 22 files to find it.', 410_000),
  ...turn(5, 90, 'Fix it', 2, 2, 'Fixed: the orders now load once. The invoice opens in under a second.', 70_000),
];

const SENT = ITEMS.filter((item) => item.kind === 'user').map((item) => (item.kind === 'user' ? item.text : ''));

function key(target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function Preview({ mode }: { mode: 'find' | 'since' }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timers: number[] = [];
    const run = () => {
      const area = box.current?.querySelector('textarea');
      if (!area) return;
      if (mode === 'find') {
        key(area, { key: 'f', ctrlKey: true });
        timers.push(window.setTimeout(() => {
          const input = box.current?.querySelector<HTMLInputElement>('.ck-find-input');
          if (input) typeInto(input, 'invoice');
        }, 150));
      } else {
        key(area, { key: 'r', ctrlKey: true });
      }
    };
    timers.push(window.setTimeout(run, 400));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [mode]);
  return (
    <div className="cockpit" style={{ position: 'fixed', inset: 0, zIndex: 99999, background: 'var(--bg)', color: 'var(--label)', overflow: 'auto', padding: 24 }}>
      <div ref={box} style={{ width: 700, height: 600, margin: '0 auto', border: '1px solid var(--sep)', borderRadius: 12, overflow: 'hidden' }}>
        <SessionChatView
          state="ready"
          reason={null}
          source="acp"
          turns={groupTurns(ITEMS).turns}
          model="Agent"
          cliVersion={null}
          paneId={mode === 'since' ? 'preview-since' : 'preview-find'}
          composer={<ChatComposer onSend={async () => null} blockedReason={null} history={SENT} />}
        />
      </div>
    </div>
  );
}

/** Before the preview mounts: the chat was last looked at after turn 2. */
export function lookedAfterTurnTwo() {
  writeSeen('preview-since', T0 + 50 * 60_000);
}
