// @vitest-environment jsdom
// The large view of a picture, through the chat's own message: a person's message with images (thumbnail click), and an
// answer with pictures the agent named. Backdrop over the whole window, picture sized by contain, Close / Escape / outside
// press, Previous / Next / Left / Right with "1 of N", focus in and back.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ChatAttachment } from '../../lib/attachFiles';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { setLanguagePref } from '../../i18n';
import { SessionChatView } from './SessionChatView';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'data:image/png;base64,AAAA';
const B = 'data:image/png;base64,BBBB';
const imageOf = (name: string): ChatAttachment => ({ name, path: `/proj/${name}`, kind: 'image', size: 10 });

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const press = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'attachment_preview') return (args as { path: string }).path.endsWith('b.png') ? B : A;
    return null;
  });
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('en');
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function chat(files: ChatAttachment[]) {
  const items: ChatItem[] = [
    { kind: 'user', id: '10:0', at: null, text: 'look', attachments: files } as ChatItem,
    { kind: 'assistant', id: '20:0', at: null, text: 'Got it.', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: '30:0', at: null, outcome: 'completed', durationMs: 1000 },
  ];
  act(() => root.render(<SessionChatView state="ready" reason={null} turns={groupTurns(items).turns} model={null} cliVersion={null} />));
  await flush();
}

describe('image viewer from a message with one image', () => {
  it('opens over the whole window, fits the picture, and shows no arrows', async () => {
    await chat([imageOf('a.png')]);
    const opener = host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!;
    opener.focus();
    await act(async () => opener.click());
    await flush();
    const box = q('[data-testid="attachment-preview"]')!;
    expect(box).not.toBeNull();
    expect(box.className).toContain('ck-lightbox'); // fixed, inset 0, rgba(0,0,0,.85) in image-lightbox.css
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(box.parentElement).toBe(host); // drawn in the app's top layer, not inside the transcript
    expect(host.querySelector('.ck-chat-turn, .ck-chat-md')?.contains(box)).toBeFalsy();
    const img = q('[data-testid="lightbox-img"]') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(A);
    expect(img.className).toContain('ck-lightbox-img'); // object-fit: contain, max 100% of the stage
    expect(q('[data-testid="lightbox-close"]')).not.toBeNull();
    expect(q('[data-testid="lightbox-nav"]')).toBeNull();
    expect(document.activeElement).toBe(q('[data-testid="lightbox-close"]'));
    await act(async () => q('[data-testid="lightbox-close"]')!.click());
    expect(q('[data-testid="attachment-preview"]')).toBeNull();
    expect(document.activeElement).toBe(opener); // focus goes back
  });

  it('closes on Escape and on a press on the backdrop, but not on a press on the picture', async () => {
    await chat([imageOf('a.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!.click());
    await flush();
    press(q('[data-testid="lightbox-img"]')!);
    expect(q('[data-testid="attachment-preview"]')).not.toBeNull();
    press(q('[data-testid="attachment-preview"]')!);
    expect(q('[data-testid="attachment-preview"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!.click());
    await flush();
    key('Escape');
    expect(q('[data-testid="attachment-preview"]')).toBeNull();
  });
});

describe('image viewer from a message with two images', () => {
  it('counts "1 of 2", steps with the arrows and the Left / Right keys, and wraps', async () => {
    await chat([imageOf('a.png'), imageOf('b.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!.click());
    await flush();
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('1 of 2');
    expect(q('[data-testid="lightbox-img"]')!.getAttribute('src')).toBe(A);
    await act(async () => q('[data-testid="lightbox-next"]')!.click());
    await flush();
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('2 of 2');
    expect(q('[data-testid="lightbox-img"]')!.getAttribute('src')).toBe(B);
    key('ArrowRight');
    await flush();
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('1 of 2');
    key('ArrowLeft');
    await flush();
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('2 of 2');
    await act(async () => q('[data-testid="lightbox-prev"]')!.click());
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('1 of 2');
  });

  it('opens at the image that was clicked, and Tab stays inside the viewer', async () => {
    await chat([imageOf('a.png'), imageOf('b.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open b.png"]')!.click());
    await flush();
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('2 of 2');
    q('[data-testid="lightbox-next"]')!.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { q('[data-testid="lightbox-next"]')!.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('[data-testid="lightbox-close"]'));
  });

  it('says Close, Previous, Next and "{n} of {total}" in zh-TW', async () => {
    setLanguagePref('zh-TW');
    await chat([imageOf('a.png'), imageOf('b.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Open"], button.ck-att-thumb')!.click());
    await flush();
    expect(q('[data-testid="lightbox-close"]')!.getAttribute('aria-label')).toBe('關閉');
    expect(q('[data-testid="lightbox-prev"]')!.getAttribute('aria-label')).toBe('上一張圖片');
    expect(q('[data-testid="lightbox-next"]')!.getAttribute('aria-label')).toBe('下一張圖片');
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('第 1 張，共 2 張');
  });
});

describe('image viewer from pictures the agent named in its answer', () => {
  it('steps through the pictures of the answer with "1 of 2"', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'chat_picture') return { name: 'p.png', mime: 'image/png', size: 1, dataUrl: (args as { path: string }).path.endsWith('b.png') ? B : A };
      return null;
    });
    const items: ChatItem[] = [
      { kind: 'user', id: '10:0', at: null, text: 'draw' } as ChatItem,
      { kind: 'assistant', id: '20:0', at: null, text: ['First:', '![first](<out/a.png>)', 'Second:', '![second](<out/b.png>)'].join('\n\n'), model: null, finalAnswer: true },
      { kind: 'turnEnd', id: '30:0', at: null, outcome: 'completed', durationMs: 1000 },
    ];
    act(() => root.render(<SessionChatView state="ready" reason={null} turns={groupTurns(items).turns} model={null} cliVersion={null}  paneId="p1" source="acp" />));
    await flush();
    await flush();
    const pics = host.querySelectorAll<HTMLButtonElement>('[data-testid="chat-picture"]');
    expect(pics).toHaveLength(2);
    await act(async () => pics[1].click());
    expect(q('[data-testid="lightbox-count"]')!.textContent).toBe('2 of 2');
    expect(q('[data-testid="lightbox-img"]')!.getAttribute('src')).toBe(B);
    key('ArrowLeft');
    expect(q('[data-testid="lightbox-img"]')!.getAttribute('src')).toBe(A);
    key('Escape');
    expect(q('[data-testid="chat-picture-big"]')).toBeNull();
  });
});

describe('image viewer layering and focus', () => {
  it('Escape closes only the viewer: a window listener behind it never sees the key', async () => {
    await chat([imageOf('a.png')]);
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!.click());
    await flush();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    window.removeEventListener('keydown', behind);
    expect(q('[data-testid="attachment-preview"]')).toBeNull();
    expect(behind).not.toHaveBeenCalled();
  });

  it('a press on the picture, then Tab, keeps focus inside the viewer', async () => {
    await chat([imageOf('a.png'), imageOf('b.png')]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open a.png"]')!.click());
    await flush();
    const box = q('[data-testid="attachment-preview"]')!;
    act(() => { q('[data-testid="lightbox-img"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(document.activeElement).toBe(box);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => { box.dispatchEvent(tab); });
    expect(box.contains(document.activeElement)).toBe(true);
    // Focus pushed to something behind the viewer comes straight back.
    const behind = host.querySelector<HTMLElement>('button.ck-att-thumb')!;
    act(() => behind.focus());
    expect(box.contains(document.activeElement)).toBe(true);
  });
});
