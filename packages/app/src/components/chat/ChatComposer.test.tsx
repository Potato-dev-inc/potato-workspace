// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatComposer, TOO_LONG_TEXT } from './ChatComposer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const sendButton = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const note = () => host.querySelector('[data-testid="chat-composer-note"]')?.textContent ?? '';

function render(onSend: (text: string) => Promise<string | null>, blockedReason: string | null = null) {
  act(() => root.render(<ChatComposer onSend={onSend} blockedReason={blockedReason} />));
}

function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

describe('ChatComposer', () => {
  it('Enter sends the text, trimmed, and empties the box', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    type('  fix the login test \n');
    const enter = press('Enter');
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('fix the login test');
    expect(field().value).toBe('');
  });

  it('Shift+Enter makes a new line and sends nothing', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    type('line one');
    const event = press('Enter', { shiftKey: true });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    expect(field().value).toBe('line one');
  });

  it('a multi-line text goes as one message with its line breaks', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    type('first\nsecond');
    press('Enter');
    await flush();
    expect(onSend).toHaveBeenCalledWith('first\nsecond');
  });

  it('Enter while an input method is composing a word sends nothing', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    type('nihon');
    press('Enter', { isComposing: true });
    await flush();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('the Send button sends too, and is off for an empty box', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    expect(sendButton().disabled).toBe(true);
    type('   ');
    expect(sendButton().disabled).toBe(true);
    press('Enter');
    await flush();
    expect(onSend).not.toHaveBeenCalled();
    type('hello');
    expect(sendButton().disabled).toBe(false);
    act(() => sendButton().click());
    await flush();
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('keeps the text and says why when the message is refused', async () => {
    const onSend = vi.fn(async () => 'Too many waiting messages.');
    render(onSend);
    type('one more');
    press('Enter');
    await flush();
    expect(field().value).toBe('one more');
    expect(note()).toContain('Too many waiting messages.');
    // Writing again clears the old complaint.
    type('one more!');
    expect(note()).toBe('');
  });

  it('is switched off with the reason when the pane cannot take messages', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend, 'Chat replies need an agent pane.');
    expect(field().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(note()).toBe('Chat replies need an agent pane.');
    press('Enter');
    await flush();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses more than 8000 characters, counting characters and not bytes', async () => {
    const onSend = vi.fn(async () => null);
    render(onSend);
    type('é'.repeat(8000));
    expect(sendButton().disabled).toBe(false);
    expect(note()).toContain('8000 / 8000');
    type('x'.repeat(8001));
    expect(sendButton().disabled).toBe(true);
    expect(note()).toContain(TOO_LONG_TEXT);
    press('Enter');
    await flush();
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('ChatComposer add files', () => {
  const attachButton = () => host.querySelector('[data-testid="chat-composer-attach"]') as HTMLButtonElement | null;

  function renderWithFiles(attachFiles: () => Promise<string[]>) {
    act(() => root.render(<ChatComposer onSend={vi.fn(async () => null)} blockedReason={null} attachFiles={attachFiles} />));
  }

  it('puts every chosen path in the message, quoting ones with a space', async () => {
    const attachFiles = vi.fn(async () => ['/a/notes.md', 'C:\\My Docs\\x.txt']);
    renderWithFiles(attachFiles);
    type('Read these');
    act(() => attachButton()!.click());
    await flush();
    expect(attachFiles).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('Read these\n/a/notes.md\n"C:\\My Docs\\x.txt"\n');
  });

  it('adds several files at once in one go', async () => {
    renderWithFiles(async () => ['/a/one.txt', '/a/two.txt', '/a/three.txt']);
    act(() => attachButton()!.click());
    await flush();
    expect(field().value).toBe('/a/one.txt\n/a/two.txt\n/a/three.txt\n');
  });

  it('says so when the file dialog cannot open', async () => {
    renderWithFiles(async () => {
      throw new Error('nope');
    });
    act(() => attachButton()!.click());
    await flush();
    expect(note()).toContain('Could not open the file dialog.');
  });

  it('has no add-files button when the box cannot take paths (the phone)', () => {
    render(vi.fn(async () => null));
    expect(attachButton()).toBeNull();
  });
});

describe('ChatComposer attachments', () => {
  const attachButton = () => host.querySelector('[data-testid="chat-composer-attach"]') as HTMLButtonElement;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockReset();
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  function renderAttach() {
    act(() =>
      root.render(
        <ChatComposer onSend={vi.fn(async () => null)} blockedReason={null} draftKey="pane-1" attachFiles={async () => ['/a/notes.md', '/a/shot.png']} />,
      ),
    );
  }

  it('puts text file contents inline and a copied file path for images', async () => {
    vi.mocked(invoke).mockResolvedValue([
      { name: 'notes.md', path: '/a/notes.md', kind: 'text', text: 'hello\n', size: 6, truncated: false },
      { name: 'shot.png', path: '/proj/.potato-workspace/attachments/1-shot.png', kind: 'file', size: 4, truncated: false },
    ]);
    renderAttach();
    type('Look at these');
    act(() => attachButton().click());
    await flush();
    expect(invoke).toHaveBeenCalledWith('attachment_prepare', { paneId: 'pane-1', paths: ['/a/notes.md', '/a/shot.png'] });
    expect(field().value).toContain('hello');
    expect(field().value).not.toContain('/a/notes.md');
    expect(field().value).toContain('/proj/.potato-workspace/attachments/1-shot.png');
  });

  it('says so when the files cannot be read', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('nope'));
    renderAttach();
    act(() => attachButton().click());
    await flush();
    expect(note()).toContain('Could not read the chosen files.');
  });
});
