// @vitest-environment jsdom
// The phone shows the same two lines as the desktop chat: the price tag under a finished answer, and the "New since
// you looked" line with its Jump to latest button.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { writeSeen } from '../../lib/chatSince';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { PhoneConversation } from './PhoneConversation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 2000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  Element.prototype.scrollIntoView = () => undefined;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 13, 1, min, 0)).toISOString();
const ITEMS: ChatItem[] = [
  { kind: 'user', id: 'u1', at: at(0), text: 'one' },
  { kind: 'assistant', id: 'a1', at: at(1), text: 'done one', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e1', at: at(2), outcome: 'completed', durationMs: 1000 },
  { kind: 'user', id: 'u2', at: at(10), text: 'two' },
  { kind: 'toolCall', id: 'c2', at: at(11), callId: 'k2', name: 'Edit', summary: 'a.ts', paths: ['a.ts'], writes: true },
  { kind: 'toolResult', id: 'r2', at: at(11), callId: 'k2', ok: true, output: 'ok' },
  { kind: 'assistant', id: 'a2', at: at(12), text: 'done two', model: null, finalAnswer: true },
  { kind: 'turnEnd', id: 'e2', at: at(13), outcome: 'completed', durationMs: 65_000 },
];

describe('PhoneConversation chat extras', () => {
  it('draws the price tag under a finished answer that did work', () => {
    act(() => root.render(<PhoneConversation state="ready" reason={null} turns={groupTurns(ITEMS).turns} chatId="ph-1" />));
    const tags = host.querySelectorAll('[data-testid="turn-price"]');
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe('1m 5s · 1 step · 1 file changed');
  });

  it('draws the new-since line and the jump button, and the button drops them', () => {
    writeSeen('ph-1', Date.parse(at(5)));
    act(() => root.render(<PhoneConversation state="ready" reason={null} turns={groupTurns(ITEMS).turns} chatId="ph-1" />));
    expect(host.querySelector('[data-testid="since-line"]')!.textContent).toBe('New since you looked · 1 answer · 1 file changed');
    act(() => void host.querySelector<HTMLButtonElement>('[data-testid="jump-latest"]')!.click());
    expect(host.querySelector('[data-testid="since-line"]')).toBeNull();
  });
});
