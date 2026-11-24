// @vitest-environment jsdom
// Run 19 live defect: a sent message came back into the box when the person left the chat and returned while the send was
// still going (A), after many fast switches (B), or after a tab switch in a far chat whose PC also holds the draft (C).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';
import { DRAFT_SAVE_MS, readDraft } from '../../lib/composerDraft';
import { REMOTE_DRAFT_MS } from '../../hooks/useRemoteDraft';
import type { RemoteDraft } from '../../lib/chatMore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let n = 0;
const pane = () => `sent-race-${++n}`;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;

function show(key: string | null, onSend: (t: string) => Promise<string | null>, remoteDraft?: RemoteDraft) {
  act(() => root.render(key ? <ChatComposer onSend={onSend} blockedReason={null} draftKey={key} remoteDraft={remoteDraft} /> : <div />));
}
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const enter = () => act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));

/** A send that stays in flight until `finish()`. */
function slowSend() {
  let finish: (v: string | null) => void = () => undefined;
  const onSend = vi.fn(() => new Promise<string | null>((r) => (finish = r)));
  return { onSend, finish: async (v: string | null = null) => { await act(async () => { finish(v); await new Promise((r) => setTimeout(r, 0)); }); } };
}

describe('a sent message does not come back', () => {
  it('A: leaving and returning while the send is in flight (draft already saved)', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('hello there');
    await wait(DRAFT_SAVE_MS + 50);
    enter();
    show(null, s.onSend);
    show(k, s.onSend);
    expect(field().value).toBe('');
    await s.finish();
    expect(field().value).toBe('');
    expect(readDraft(k)).toBe('');
  });

  it('A2: send right after typing, switch away within 50 ms and back', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('quick one');
    enter();
    show(null, s.onSend);
    await wait(50);
    show(k, s.onSend);
    expect(field().value).toBe('');
    await s.finish();
    await wait(DRAFT_SAVE_MS + 50);
    expect(field().value).toBe('');
    expect(readDraft(k)).toBe('');
  });

  it('B: 180 fast switches between two chats, random timing, ending on the chat that sent', async () => {
    const a = pane();
    const b = pane();
    const s = slowSend();
    show(a, s.onSend);
    type('sent text');
    await wait(DRAFT_SAVE_MS + 20);
    enter();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 180; i++) {
      show(i % 2 === 0 ? b : a, s.onSend);
      if (rnd() < 0.1) await wait(Math.floor(rnd() * 20));
    }
    show(a, s.onSend);
    await s.finish();
    await wait(DRAFT_SAVE_MS + 50);
    expect(field().value).toBe('');
    expect(readDraft(a)).toBe('');
  });

  it('C: far chat, tab switch while sending: the PC copy of the draft does not bring the text back', async () => {
    const k = pane();
    let pcCopy = '';
    const remote: RemoteDraft = { read: async () => pcCopy, write: (t) => void (pcCopy = t) };
    const s = slowSend();
    show(k, s.onSend, remote);
    type('hi');
    await wait(REMOTE_DRAFT_MS + 50);
    expect(pcCopy).toBe('hi');
    enter();
    show(null, s.onSend, remote); // the Changes tab
    show(k, s.onSend, remote); // back to Chat
    await wait(20);
    expect(field().value).toBe('');
    await s.finish();
    await wait(REMOTE_DRAFT_MS + 50);
    expect(field().value).toBe('');
    expect(pcCopy).toBe('');
    type('Write the numbers');
    expect(field().value).toBe('Write the numbers');
  });

  it('a refused send keeps the text even if the box was left meanwhile', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('keep me');
    await wait(DRAFT_SAVE_MS + 50);
    enter();
    show(null, s.onSend);
    await s.finish('Too many waiting messages.');
    show(k, s.onSend);
    expect(field().value).toBe('keep me');
  });

  it('D: words typed while a slow send is in flight do not join the sent ones, and are kept when it ends', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('pong');
    enter();
    expect(field().value).toBe('');
    type('next words');
    await s.finish();
    expect(field().value).toBe('next words');
  });

  it('E: a refused slow send puts its words back into an empty box', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('please');
    enter();
    await s.finish('Not now.');
    expect(field().value).toBe('please');
  });

  it('F: a refused slow send keeps what was typed meanwhile, the refused words in front', async () => {
    const k = pane();
    const s = slowSend();
    show(k, s.onSend);
    type('please');
    enter();
    type('and also');
    await s.finish('Not now.');
    expect(field().value).toBe('please\nand also');
  });
});
