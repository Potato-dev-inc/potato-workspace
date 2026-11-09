// @vitest-environment jsdom
// The `@` mention in the composer: typing "@word" opens the project file picker, Enter picks a file (it becomes a chip
// and the @word text goes), Enter while the picker is open never sends, Esc closes it and keeps the text, and an email
// like "a@b" does not open it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ChatComposer } from './ChatComposer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => undefined) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HITS = [
  { path: 'docs/readme.md', absPath: '/proj/docs/readme.md', name: 'readme.md', size: 120 },
  { path: 'src/reader.ts', absPath: '/proj/src/reader.ts', name: 'reader.ts', size: 800 },
];

let host: HTMLDivElement;
let root: Root;
let sent: unknown[];

function backend(cmd: string, args?: unknown): unknown {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case 'project_files_search':
      return HITS;
    case 'attachment_prepare':
      return (a.paths as string[]).map((path) => ({ name: path.split(/[\/]/).pop(), path, kind: 'text', size: 120 }));
    case 'pane_message_send':
      sent.push(a);
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
  sent = [];
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => backend(cmd, args));
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
/** The picker debounces its search by 120 ms, then the backend answers: wait past both. */
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 160)); });
  for (let i = 0; i < 6; i++) await flush();
};
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const picker = () => host.querySelector('[data-testid="project-file-picker"]');
const chipNames = () => Array.from(host.querySelectorAll('[data-testid="attachment-chip"]')).map((el) => el.getAttribute('data-name'));

function mount(draftKey = 'pane-1') {
  act(() =>
    root.render(
      <ChatComposer
        onSend={async (text, attachments) => {
          sent.push({ text, attachments });
          return null;
        }}
        blockedReason={null}
        draftKey={draftKey}
        attachFiles={async () => []}
      />,
    ),
  );
}

/** Types into the box as a user would: sets the value, then fires input with the caret at the end. */
function type(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().setSelectionRange(text.length, text.length);
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

describe('ChatComposer @ mention', () => {
  it('typing "@rea" opens the picker and searches with the query "rea"', async () => {
    mount();
    type('@rea');
    await settle();
    expect(picker()).not.toBeNull();
    const searches = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'project_files_search');
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[searches.length - 1][1]).toMatchObject({ paneId: 'pane-1', query: 'rea' });
  });

  it('Enter picks the file: the @rea text goes and a chip appears', async () => {
    mount();
    type('Look at @rea');
    await settle();
    const event = press('Enter');
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(field().value).toBe('Look at ');
    expect(chipNames()).toEqual(['readme.md']);
    expect(picker()).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === 'attachment_prepare' && (args as { paths: string[] }).paths[0] === '/proj/docs/readme.md')).toBe(true);
    expect(sent).toEqual([]);
  });

  it('Enter while the picker is open does not send', async () => {
    mount();
    type('@rea');
    await settle();
    press('Enter');
    await settle();
    expect(sent).toEqual([]);
    // With the picker closed, Enter sends as usual (the attached chip is the message).
    expect(chipNames()).toEqual(['readme.md']);
  });

  it('Enter with no matches closes the picker and sends as normal', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) =>
      cmd === 'project_files_search' ? [] : backend(cmd, args),
    );
    mount();
    type('@zzzz');
    await settle();
    expect(picker()).not.toBeNull();
    press('Enter');
    await settle();
    expect(picker()).toBeNull();
    expect(sent).toEqual([{ text: '@zzzz', attachments: undefined }]);
  });

  it('Esc closes the picker and keeps the text', async () => {
    mount();
    type('Hi @rea');
    await settle();
    expect(picker()).not.toBeNull();
    press('Escape');
    await settle();
    expect(picker()).toBeNull();
    expect(field().value).toBe('Hi @rea');
    expect(chipNames()).toEqual([]);
  });

  it('an email like "a@b" does not open the picker', async () => {
    mount();
    type('mail a@b');
    await settle();
    expect(picker()).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'project_files_search')).toBe(false);
    expect(field().value).toBe('mail a@b');
  });
});
