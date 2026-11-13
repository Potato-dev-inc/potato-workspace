// @vitest-environment jsdom
// Editing a message that waits in the queue: Edit opens a small editor and holds the message back, Save keeps its
// place with the new text, Cancel lets the old text go on, Remove takes it out. A fake queue (the same rule the PC
// has: a held message, and the ones behind it, are not sent) shows that nothing leaves early.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePaneOutbox } from '../../hooks/usePaneOutbox';
import type { OutboxMessage, OutboxTransport } from '../../lib/paneOutbox';
import { PendingMessages } from './PendingMessages';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const buttons = (label: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent === label);
const rows = () => [...host.querySelectorAll('[data-testid="chat-pending"]')];

/** The PC's queue in miniature: `drain` is "the agent got ready" (sends the first message that is not held). */
class FakeQueue {
  list: OutboxMessage[];
  held = new Set<string>();
  sent: string[] = [];
  push: ((list: OutboxMessage[]) => void) | null = null;
  constructor(texts: string[]) {
    this.list = texts.map((text, i) => ({ id: `m${i + 1}`, text, createdAt: i, state: 'queued', waitingFor: null, error: null }));
  }
  private publish() {
    this.push?.([...this.list]);
  }
  private find(id: string): OutboxMessage {
    const m = this.list.find((x) => x.id === id && x.state === 'queued');
    if (!m) throw new Error('That message is not waiting any more.');
    return m;
  }
  drain() {
    const first = this.list.find((m) => m.state === 'queued');
    if (!first || this.held.has(first.id)) return;
    this.sent.push(first.text);
    this.list = this.list.map((m) => (m === first ? { ...m, state: 'sent' as const } : m));
    this.publish();
  }
  transport: OutboxTransport = {
    send: async () => { throw new Error('not used'); },
    cancel: async (_p, id) => {
      const m = this.find(id);
      const done = { ...m, state: 'cancelled' as const };
      this.list = this.list.map((x) => (x === m ? done : x));
      this.publish();
      return done;
    },
    hold: async (_p, id, hold) => {
      const m = this.find(id);
      if (hold) this.held.add(id);
      else this.held.delete(id);
      return m;
    },
    edit: async (_p, id, text) => {
      const m = this.find(id);
      const done = { ...m, text: text.trim() };
      this.held.delete(id);
      this.list = this.list.map((x) => (x === m ? done : x));
      this.publish();
      return done;
    },
    list: async () => [...this.list],
    watch: (_p, cb) => {
      this.push = cb;
      return () => { this.push = null; };
    },
  };
}

function Harness({ queue }: { queue: FakeQueue }) {
  const outbox = usePaneOutbox(queue.transport, 'p1', true);
  return <PendingMessages messages={outbox.messages.filter((m) => m.state === 'queued')} onCancel={outbox.cancel} onHold={outbox.hold} onEdit={outbox.edit} onHide={() => {}} />;
}

async function mount(queue: FakeQueue) {
  act(() => root.render(<Harness queue={queue} />));
  await flush();
}

function type(textarea: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('editing a queued message', () => {
  it('Edit opens the editor with the text; Save puts the new text back in the same place', async () => {
    const queue = new FakeQueue(['first', 'second', 'third']);
    await mount(queue);
    expect(rows()).toHaveLength(3);
    await act(async () => buttons('Edit')[1]!.click());
    await flush();
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(box.value).toBe('second');
    type(box, 'second, but better');
    await act(async () => buttons('Save')[0]!.click());
    await flush();
    expect(host.querySelector('textarea')).toBeNull();
    expect(rows().map((r) => r.querySelector('.ck-chat-bubble')?.textContent)).toEqual(['first', 'second, but better', 'third']);
    expect(queue.sent).toEqual([]);
  });

  it('nothing is sent while a message is open for edit, even when the agent gets ready; Save lets it go with the new text', async () => {
    const queue = new FakeQueue(['first', 'second']);
    await mount(queue);
    await act(async () => buttons('Edit')[0]!.click());
    await flush();
    act(() => queue.drain());
    act(() => queue.drain());
    expect(queue.sent).toEqual([]);
    type(host.querySelector('textarea') as HTMLTextAreaElement, 'first (edited)');
    await act(async () => buttons('Save')[0]!.click());
    await flush();
    act(() => queue.drain());
    act(() => queue.drain());
    expect(queue.sent).toEqual(['first (edited)', 'second']);
  });

  it('Cancel closes the editor, keeps the old text and lets the message go on', async () => {
    const queue = new FakeQueue(['keep me']);
    await mount(queue);
    await act(async () => buttons('Edit')[0]!.click());
    await flush();
    type(host.querySelector('textarea') as HTMLTextAreaElement, 'changed my mind');
    await act(async () => buttons('Cancel')[0]!.click());
    await flush();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('keep me');
    expect(queue.held.size).toBe(0);
    act(() => queue.drain());
    expect(queue.sent).toEqual(['keep me']);
  });

  it('Remove takes the message out of the queue', async () => {
    const queue = new FakeQueue(['a', 'b']);
    await mount(queue);
    await act(async () => buttons('Remove')[0]!.click());
    await flush();
    expect(rows().map((r) => r.querySelector('.ck-chat-bubble')?.textContent)).toEqual(['b']);
    expect(queue.sent).toEqual([]);
  });

  it('cannot save an empty text, and says so when the message was already sent', async () => {
    const queue = new FakeQueue(['solo']);
    await mount(queue);
    await act(async () => buttons('Edit')[0]!.click());
    await flush();
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    type(box, '   ');
    expect(buttons('Save')[0]!.disabled).toBe(true);
    type(box, 'solo again');
    // It left meanwhile (the PC sent it before the hold, or another device did).
    queue.list = queue.list.map((m) => ({ ...m, state: 'sent' as const }));
    await act(async () => buttons('Save')[0]!.click());
    await flush();
    expect(host.querySelector('[data-testid="chat-pending-edit-error"]')?.textContent).toBe('That message is not waiting any more.');
  });

  it('shows no Edit without the edit calls, and none on a message that is being sent', () => {
    const msg = (state: OutboxMessage['state']): OutboxMessage => ({ id: 'x', text: 'hi', createdAt: 1, state, waitingFor: null, error: null });
    act(() => root.render(<PendingMessages messages={[msg('queued')]} onCancel={async () => null} onHide={() => {}} />));
    expect(buttons('Edit')).toHaveLength(0);
    act(() => root.render(<PendingMessages messages={[msg('sending')]} onCancel={async () => null} onHold={async () => null} onEdit={async () => null} onHide={() => {}} />));
    expect(buttons('Edit')).toHaveLength(0);
  });
});
