// @vitest-environment jsdom
// The shared chips: the read-only transcript form, the image preview overlay (Escape closes), and the transcript
// that shows a person's attachments above their message (and hides an empty bubble).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ChatAttachment } from '../../lib/attachFiles';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { AttachmentChips, extensionOf, formatSize } from './AttachmentChips';
import { SessionChatView, type SessionChatViewProps } from './SessionChatView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(null);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const chips = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]'));

const IMAGE: ChatAttachment = { name: 'shot.png', path: '/proj/shot.png', kind: 'image', size: 4096 };
const DOC: ChatAttachment = { name: 'notes.md', path: '/proj/notes.md', kind: 'text', size: 2300 };

describe('AttachmentChips', () => {
  it('shows a file card with the extension and size, and an image as a thumbnail', () => {
    act(() => root.render(<AttachmentChips attachments={[IMAGE, DOC]} />));
    expect(chips().map((c) => c.getAttribute('data-kind'))).toEqual(['image', 'text']);
    expect(host.textContent).toContain('MD · 2.2 KB');
  });

  it('has no x when read-only, and an x per chip with onRemove', () => {
    act(() => root.render(<AttachmentChips attachments={[DOC]} />));
    expect(host.querySelector('button[aria-label="Remove notes.md"]')).toBeNull();
    const onRemove = vi.fn();
    act(() => root.render(<AttachmentChips attachments={[DOC]} onRemove={onRemove} />));
    (host.querySelector('button[aria-label="Remove notes.md"]') as HTMLButtonElement).click();
    expect(onRemove).toHaveBeenCalledWith(DOC);
  });

  it('opens a larger image preview on click, and Escape closes it', async () => {
    act(() => root.render(<AttachmentChips attachments={[IMAGE]} />));
    (host.querySelector('button[aria-label="Open shot.png"]') as HTMLButtonElement).click();
    await flush();
    expect(host.querySelector('[data-testid="attachment-preview"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(host.querySelector('[data-testid="attachment-preview"]')).toBeNull();
  });

  it('shows nothing for an empty list', () => {
    act(() => root.render(<AttachmentChips attachments={[]} />));
    expect(chips()).toHaveLength(0);
    expect(host.querySelector('[data-testid="attachment-chips"]')).toBeNull();
  });
});

describe('small helpers', () => {
  it('formats sizes and extensions in plain words', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(3500)).toBe('3.4 KB');
    expect(formatSize(12 * 1024 * 1024)).toBe('12 MB');
    expect(extensionOf('notes.md')).toBe('MD');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.env')).toBe('');
  });
});

describe('transcript shows a person\'s attachments', () => {
  const items = (user: Partial<Extract<ChatItem, { kind: 'user' }>>): ChatItem[] => [
    { kind: 'user', id: '10:0', at: null, text: '', ...user } as ChatItem,
    { kind: 'assistant', id: '20:0', at: null, text: 'Got it.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: '30:0', at: null, outcome: 'completed', durationMs: 1000 },
  ];

  function render(list: ChatItem[]) {
    const props: SessionChatViewProps = { state: 'ready', reason: null, turns: groupTurns(list).turns, model: null, cliVersion: null };
    act(() => root.render(<SessionChatView {...props} />));
  }

  it('renders the chips read-only and hides the bubble when the text is empty', () => {
    render(items({ attachments: [IMAGE, DOC] }));
    const row = host.querySelector('[data-testid="attachment-chips"]');
    expect(row).not.toBeNull();
    expect(chips()).toHaveLength(2);
    expect(host.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(host.querySelector('.ck-chat-bubble')).toBeNull();
    expect(host.textContent).toContain('Got it.');
  });

  it('shows the chips above the bubble when there is text too', () => {
    render(items({ text: 'See the shot', attachments: [IMAGE] }));
    const bubble = host.querySelector('.ck-chat-bubble');
    expect(bubble?.textContent).toBe('See the shot');
    const row = host.querySelector('[data-testid="attachment-chips"]')!;
    expect(row.compareDocumentPosition(bubble!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a message with no files renders as before', () => {
    render(items({ text: 'plain' }));
    expect(chips()).toHaveLength(0);
    expect(host.querySelector('.ck-chat-bubble')?.textContent).toBe('plain');
  });
});
