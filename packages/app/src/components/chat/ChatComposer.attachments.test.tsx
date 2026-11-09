// @vitest-environment jsdom
// The composer's attachment chips: + and drop, paste of images, x, duplicates, sending with files, the draft that keeps
// them, and that the message text never carries file contents.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ChatComposer } from './ChatComposer';
import { DRAFT_SAVE_MS, LS_COMPOSER_DRAFTS } from '../../lib/composerDraft';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const drag = vi.hoisted(() => ({ handler: null as null | ((event: unknown) => void) }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: unknown) => void) => {
      drag.handler = handler;
      return Promise.resolve(() => undefined);
    },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

/** A fake backend: prepare describes each path, saved pastes get a path in the pane's project. */
function backend(cmd: string, args?: unknown): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case 'attachment_prepare':
      return (a.paths as string[]).map((path) => ({
        name: path.split(/[\\/]/).pop(),
        path,
        kind: path.endsWith('.png') ? 'image' : 'text',
        size: 2048,
      }));
    case 'attachment_save_pasted':
      return { name: a.name, path: `/proj/.potato-workspace/attachments/${a.name}`, kind: 'image', size: 3, mime: a.mime };
    case 'attachment_preview':
      return null;
    case 'pane_message_send':
      return { id: 'm1', text: a.text, createdAt: 1, state: 'queued', waitingFor: null, error: null };
    default:
      return null;
  }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => backend(cmd, args));
  localStorage.clear();
  drag.handler = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
/** Lets FileReader and the backend calls finish (several ticks). */
const settle = async () => {
  for (let i = 0; i < 8; i++) await flush();
};
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const sendButton = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const attachButton = () => host.querySelector('[data-testid="chat-composer-attach"]') as HTMLButtonElement;
const addFilesViaMenu = (label = 'Add files…') => {
  act(() => attachButton()!.click());
  const item = Array.from(host.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes(label)) as HTMLElement;
  act(() => item.click());
};
const chips = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]'));
const chipNames = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]')).map((el) => el.getAttribute('data-name'));
const note = () => host.querySelector('[data-testid="chat-composer-note"]')?.textContent ?? '';

function mount(props: Partial<Parameters<typeof ChatComposer>[0]> = {}, draftKey = 'pane-1') {
  const onSend = props.onSend ?? vi.fn(async () => null);
  act(() =>
    root.render(
      <ChatComposer onSend={onSend} blockedReason={null} draftKey={draftKey} attachFiles={async () => ['/a/notes.md', '/a/shot.png']} {...props} />,
    ),
  );
  return onSend;
}

function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Dispatches a paste on the box. Returns the event so the test can see whether the default was prevented. */
function paste(files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files, items: [], types: text ? ['text/plain'] : [], getData: () => text } });
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

describe('ChatComposer chips from + and drop', () => {
  it('adds a folder chip from + then Add folder…', async () => {
    vi.mocked(open).mockResolvedValueOnce('/proj/src' as never);
    mount();
    addFilesViaMenu('Add folder…');
    await settle();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(chipNames()).toEqual(['src']);
  });

  it('shows a chip per file after +, and the text is untouched', async () => {
    mount();
    type('Look');
    addFilesViaMenu();
    await settle();
    expect(chipNames()).toEqual(['notes.md', 'shot.png']);
    expect(field().value).toBe('Look');
  });

  it('shows the same chips after a drop on the box', async () => {
    mount();
    await settle();
    expect(drag.handler).not.toBeNull();
    act(() => drag.handler!({ payload: { type: 'drop', paths: ['/a/notes.md'], position: { x: 0, y: 0 } } }));
    await settle();
    expect(chipNames()).toEqual(['notes.md']);
    expect(field().value).toBe('');
  });

  it('ignores a file that is already attached', async () => {
    mount({ attachFiles: async () => ['/a/notes.md'] });
    addFilesViaMenu();
    await settle();
    addFilesViaMenu();
    await settle();
    expect(chipNames()).toEqual(['notes.md']);
  });

  it('shows a spinner chip while the files are prepared', async () => {
    let finish: (v: unknown) => void = () => undefined;
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      cmd === 'attachment_prepare' ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(backend(cmd)),
    );
    mount();
    addFilesViaMenu();
    await flush();
    expect(host.querySelector('[data-testid="attachment-preparing"]')).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    await act(async () => finish([{ name: 'notes.md', path: '/a/notes.md', kind: 'text', size: 10 }]));
    await settle();
    expect(host.querySelector('[data-testid="attachment-preparing"]')).toBeNull();
    expect(chipNames()).toEqual(['notes.md']);
  });
});

describe('ChatComposer remove and paste', () => {
  it('the x removes one chip and leaves the others', async () => {
    mount();
    addFilesViaMenu();
    await settle();
    const remove = host.querySelector('button[aria-label="Remove notes.md"]') as HTMLButtonElement;
    expect(remove).not.toBeNull();
    act(() => remove.click());
    expect(chipNames()).toEqual(['shot.png']);
  });

  it('pasting an image saves it for the pane and shows a chip', async () => {
    mount();
    const png = new File(['pngdata'], 'shot.png', { type: 'image/png' });
    const event = paste([png]);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(invoke).toHaveBeenCalledWith(
      'attachment_save_pasted',
      expect.objectContaining({ paneId: 'pane-1', name: 'Pasted image 1.png', mime: 'image/png' }),
    );
    expect(chipNames()).toEqual(['Pasted image 1.png']);
    expect(field().value).toBe('');
  });

  it('a plain text paste is left alone', async () => {
    mount();
    const event = paste([], 'hello there');
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('attachment_save_pasted', expect.anything());
    expect(chips()).toHaveLength(0);
  });
});

describe('ChatComposer send with files', () => {
  it('sends the text with the chips and clears both', async () => {
    const onSend = mount({ onSend: vi.fn(async () => null) });
    type('see these');
    addFilesViaMenu();
    await settle();
    act(() => sendButton().click());
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    const [text, sent] = vi.mocked(onSend).mock.calls[0] as unknown as [string, { name: string }[]];
    expect(text).toBe('see these');
    expect(sent.map((a) => a.name)).toEqual(['notes.md', 'shot.png']);
    expect(field().value).toBe('');
    expect(chips()).toHaveLength(0);
  });

  it('sends with only files and no text', async () => {
    const onSend = mount({ onSend: vi.fn(async () => null), attachFiles: async () => ['/a/notes.md'] });
    addFilesViaMenu();
    await settle();
    expect(sendButton().disabled).toBe(false);
    act(() => sendButton().click());
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onSend).mock.calls[0][0]).toBe('');
    expect(chips()).toHaveLength(0);
  });

  it('keeps the chips when the send is refused', async () => {
    mount({ onSend: vi.fn(async () => 'The pane is busy.') });
    addFilesViaMenu();
    await settle();
    act(() => sendButton().click());
    await settle();
    expect(note()).toContain('The pane is busy.');
    expect(chipNames()).toEqual(['notes.md', 'shot.png']);
  });

  it('a plain text send passes no attachments, as before', async () => {
    const onSend = mount({ onSend: vi.fn(async () => null) });
    type('hello');
    act(() => sendButton().click());
    await settle();
    expect(vi.mocked(onSend).mock.calls[0]).toEqual(['hello']);
  });

  it('the message text never contains "Attached file:"', async () => {
    const onSend = mount({ onSend: vi.fn(async () => null) });
    addFilesViaMenu();
    await settle();
    act(() => sendButton().click());
    await settle();
    expect(String(vi.mocked(onSend).mock.calls[0][0])).not.toContain('Attached file:');
  });
});

describe('ChatComposer draft keeps the chips', () => {
  it('restores the chips and text after the box is closed and opened again', async () => {
    mount();
    type('half a thought');
    addFilesViaMenu();
    await settle();
    await new Promise((r) => setTimeout(r, DRAFT_SAVE_MS + 50));
    expect(localStorage.getItem(LS_COMPOSER_DRAFTS)).toContain('"attachments"');
    act(() => root.unmount());
    root = createRoot(host);
    mount();
    await settle();
    expect(field().value).toBe('half a thought');
    expect(chipNames()).toEqual(['notes.md', 'shot.png']);
  });

  it('an old draft with only text still loads, with no chips', async () => {
    localStorage.setItem(LS_COMPOSER_DRAFTS, JSON.stringify({ 'pane-1': { text: 'old words', at: Date.now() } }));
    mount();
    await settle();
    expect(field().value).toBe('old words');
    expect(chips()).toHaveLength(0);
  });
});
