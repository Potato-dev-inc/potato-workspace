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
  const chipNames = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]')).map((el) => el.getAttribute('data-name'));
  const addFilesViaMenu = (label = 'Add files…') => {
    act(() => attachButton()!.click());
    const item = Array.from(host.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes(label)) as HTMLElement;
    act(() => item.click());
  };

  beforeEach(() => {
    localStorage.clear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'attachment_prepare') {
        const paths = (args as { paths: string[] }).paths;
        return paths.map((path) => ({ name: path.split(/[\\/]/).pop(), path, kind: path.endsWith('.png') ? 'image' : 'text', size: 2048 }));
      }
      return null;
    });
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  function renderWithFiles(attachFiles: () => Promise<string[]>) {
    act(() => root.render(<ChatComposer onSend={vi.fn(async () => null)} blockedReason={null} draftKey="pane-1" attachFiles={attachFiles} />));
  }

  it('adds a chip for every chosen file and leaves the text alone', async () => {
    const attachFiles = vi.fn(async () => ['/a/notes.md', 'C:\\My Docs\\x.txt']);
    renderWithFiles(attachFiles);
    type('Read these');
    addFilesViaMenu();
    await flush();
    expect(attachFiles).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('attachment_prepare', { paneId: 'pane-1', paths: ['/a/notes.md', 'C:\\My Docs\\x.txt'] });
    expect(chipNames()).toEqual(['notes.md', 'x.txt']);
    expect(field().value).toBe('Read these');
  });

  it('adds several files at once in one go', async () => {
    renderWithFiles(async () => ['/a/one.txt', '/a/two.txt', '/a/three.txt']);
    addFilesViaMenu();
    await flush();
    expect(chipNames()).toEqual(['one.txt', 'two.txt', 'three.txt']);
    expect(field().value).toBe('');
  });

  it('says so when the file dialog cannot open', async () => {
    renderWithFiles(async () => {
      throw new Error('nope');
    });
    addFilesViaMenu();
    await flush();
    expect(note()).toContain('Could not open the file dialog.');
  });

  it('says so when the files cannot be read, and adds no chip', async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockRejectedValue(new Error('nope'));
    renderWithFiles(async () => ['/a/notes.md']);
    addFilesViaMenu();
    await flush();
    expect(note()).toContain('Could not read the chosen files.');
    expect(chipNames()).toEqual([]);
  });

  it('has no add-files button when the box cannot take paths (the phone)', () => {
    render(vi.fn(async () => null));
    expect(attachButton()).toBeNull();
  });
});
