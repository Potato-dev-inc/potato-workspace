// @vitest-environment jsdom
// The phone's own waiting list (messages typed while the PC was away) has Edit as well as Remove; the PC's waiting messages
// (the desktop's hold/edit routes) are edited in PendingMessages, which PhoneChatView wires with onHold + onEdit.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneQueueBar } from './PhoneQueueBar';
import { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { readQueue } from '../../lib/phone-queue';
import { labelFromMessage, publishChatMeta, resetChatMetaForTests, chatMetaOf, LABEL_MAX } from '../../lib/phone-chatmeta';
import { tabLabels } from '../../lib/mobile-agent-tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetChatMetaForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Harness() {
  const queue = useOfflineQueue('p1', 'full');
  const [seeded, setSeeded] = useState(false);
  if (!seeded) {
    setSeeded(true);
    queue.add('first words');
    queue.add('second words');
  }
  return <PhoneQueueBar waiting={queue.waiting} reachable={false} onSend={async () => null} onDiscard={queue.discard} onRemove={queue.remove} onEdit={queue.edit} />;
}
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const typeInto = (box: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Edit on the phone queue', () => {
  it('opens a box with the words, saves new words in the same place, and keeps them on the phone', async () => {
    await act(async () => root.render(<Harness />));
    const edits = host.querySelectorAll<HTMLButtonElement>('.ph-qlist li > button.ph-qbtn');
    expect(edits).toHaveLength(2);
    await click(edits[0]);
    const box = host.querySelector('.ph-qedit textarea') as HTMLTextAreaElement;
    expect(box.value).toBe('first words');
    expect(document.activeElement).toBe(box);
    await typeInto(box, 'better words');
    await click(Array.from(host.querySelectorAll('.ph-qedit button')).find((b) => b.textContent === 'Save'));
    expect(host.querySelector('.ph-qedit')).toBeNull();
    expect(Array.from(host.querySelectorAll('.ph-qtext')).map((n) => n.textContent)).toEqual(['better words', 'second words']);
    expect(readQueue('p1').map((m) => m.text)).toEqual(['better words', 'second words']);
  });

  it('Cancel leaves the words as they were, and Save is off for an empty box', async () => {
    await act(async () => root.render(<Harness />));
    await click(host.querySelector('.ph-qlist li > button.ph-qbtn'));
    const box = host.querySelector('.ph-qedit textarea') as HTMLTextAreaElement;
    await typeInto(box, '   ');
    const save = Array.from(host.querySelectorAll<HTMLButtonElement>('.ph-qedit button')).find((b) => b.textContent === 'Save')!;
    expect(save.disabled).toBe(true);
    await click(Array.from(host.querySelectorAll('.ph-qedit button')).find((b) => b.textContent === 'Cancel'));
    expect(readQueue('p1').map((m) => m.text)).toEqual(['first words', 'second words']);
  });
});

describe('the chat label', () => {
  it('is the first message cut at a word, 32 characters at most, with the code marks taken out', () => {
    const label = labelFromMessage('Fix the `pairing` check in the bridge so that a phone behind a tunnel cannot sneak in')!;
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(label).toBe('Fix the pairing check in the…');
    expect(labelFromMessage('hi')).toBe('hi');
    expect(labelFromMessage('   ')).toBeNull();
    expect(labelFromMessage(null)).toBeNull();
  });

  it('comes after the PC title and before the numbered agent name', () => {
    const pane = (id: string, title?: string) => ({ id, agent_type: 'claude', status: 'idle', created_at: Number(id.slice(1)), cwd: 'C:/x', pid: 1, last_output_at: null, cols: 80, rows: 24, title }) as never;
    const labels = tabLabels([pane('a1', 'Pairing'), pane('a2'), pane('a3')], undefined, new Map([['a1', 'ignored'], ['a2', 'Fix the login']]));
    expect(labels.get('a1')).toBe('Pairing');
    expect(labels.get('a2')).toBe('Fix the login');
    expect(labels.get('a3')).toBe('Claude 3');
  });

  it('a known label is kept when a later publish has none', () => {
    publishChatMeta('p1', { label: 'Fix the login' });
    publishChatMeta('p1', { label: null, sending: true });
    expect(chatMetaOf('p1')).toMatchObject({ label: 'Fix the login', sending: true });
  });
});
