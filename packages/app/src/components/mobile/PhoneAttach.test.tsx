// @vitest-environment jsdom
// P14 on the phone: the "+" menu (Camera, Photos, Files, Paste), the chip in the box with its picture, the checks the PC also
// makes (10 MB, type), and the message that goes out with the files. Nothing is sent until Send.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import type { ChatAttachment } from '../../lib/attachFiles';
import { PhoneComposer } from './PhoneComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const saved = (name: string, size = 2048): ChatAttachment => ({ name, path: `/tmp/phone-uploads/2026-11-13/${name}`, kind: 'image', size, mime: 'image/png' });

function mount(upload: ((file: File) => Promise<ChatAttachment>) | null, onSend = vi.fn(async () => null as string | null)) {
  act(() => {
    root.render(<PhoneComposer onSend={onSend} blockedReason={null} draftKey="p1" model="Sonnet 5" upload={upload} />);
  });
  return onSend;
}

function openMenu() {
  act(() => (host.querySelector('[aria-label="Add"]') as HTMLButtonElement).click());
}

async function pick(testId: string, file: File) {
  const input = host.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function fileOf(name: string, type: string, size = 2048): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

const send = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const note = () => host.querySelector('[data-testid="phone-composer-note"]')?.textContent ?? '';

describe('the plus menu', () => {
  it('lists Camera, Photos, Files and Paste, each with a real picker behind it', () => {
    mount(async () => saved('a.png'));
    openMenu();
    const menu = host.querySelector('[data-testid="phone-plus-menu"]')!;
    for (const word of ['Camera', 'Photos', 'Files', 'Paste']) expect(menu.textContent).toContain(word);
    expect(menu.textContent).not.toContain('Not on this PC yet');
    const camera = host.querySelector('[data-testid="phone-pick-camera"]') as HTMLInputElement;
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.getAttribute('accept')).toBe('image/*');
    expect((host.querySelector('[data-testid="phone-pick-files"]') as HTMLInputElement).accept).toContain('.pdf');
  });

  it('says so when the PC cannot take files, and a click then does nothing', () => {
    mount(null);
    openMenu();
    const menu = host.querySelector('[data-testid="phone-plus-menu"]')!;
    expect(menu.textContent).toContain('Not on this PC yet');
    expect(menu.querySelector('button')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('closes on Escape', () => {
    mount(async () => saved('a.png'));
    openMenu();
    act(() => {
      host.querySelector('[data-testid="phone-plus-menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-testid="phone-plus-menu"]')).toBeNull();
  });
});

describe('a picked file', () => {
  it('goes to the PC at once, shows as a chip, and goes with the message when Send is pressed', async () => {
    const upload = vi.fn(async (file: File) => saved(file.name));
    const onSend = mount(upload);
    openMenu();
    await pick('phone-pick-photos', fileOf('screenshot.png', 'image/png'));
    expect(upload).toHaveBeenCalledTimes(1);
    const chips = host.querySelector('[data-testid="phone-attach-chips"]')!;
    expect(chips.textContent).toContain('screenshot.png');
    expect(chips.textContent).toContain('2 KB');
    expect(onSend).not.toHaveBeenCalled();
    // A file alone is enough to send.
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(onSend).toHaveBeenCalledWith('', [saved('screenshot.png')]);
    expect(host.querySelector('[data-testid="phone-attach-chips"]')).toBeNull();
  });

  it('keeps Send off while the file is still on its way', async () => {
    let finish: (a: ChatAttachment) => void = () => undefined;
    const upload = vi.fn(() => new Promise<ChatAttachment>((resolve) => (finish = resolve)));
    mount(upload);
    openMenu();
    await pick('phone-pick-files', fileOf('notes.txt', 'text/plain'));
    expect(host.querySelector('[data-testid="phone-attach-chips"]')!.textContent).toContain('Sending to your PC');
    expect(send().disabled).toBe(true);
    await act(async () => finish(saved('notes.txt')));
    expect(send().disabled).toBe(false);
  });

  it('refuses a file over 10 MB and a type the PC does not take, without asking the PC', async () => {
    const upload = vi.fn(async (file: File) => saved(file.name));
    mount(upload);
    openMenu();
    await pick('phone-pick-files', fileOf('movie.pdf', 'application/pdf', 10 * 1024 * 1024 + 1));
    expect(note()).toContain('bigger than 10 MB');
    openMenu();
    await pick('phone-pick-files', fileOf('run.exe', 'application/octet-stream'));
    expect(note()).toContain('Only pictures, PDF and text files');
    expect(upload).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="phone-attach-chips"]')).toBeNull();
  });

  it('a camera photo with no extension is taken by its picture type', async () => {
    const upload = vi.fn(async (file: File) => saved(file.name));
    mount(upload);
    openMenu();
    await pick('phone-pick-camera', fileOf('', 'image/jpeg'));
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('shows the PC reason on the chip when the file could not be sent, and the chip can be removed', async () => {
    mount(async () => {
      throw new Error('The PC could not save the file.');
    });
    openMenu();
    await pick('phone-pick-photos', fileOf('a.png', 'image/png'));
    const chips = host.querySelector('[data-testid="phone-attach-chips"]')!;
    expect(chips.textContent).toContain('The PC could not save the file.');
    expect(send().disabled).toBe(true);
    act(() => (chips.querySelector('.ph-chip-x') as HTMLButtonElement).click());
    expect(host.querySelector('[data-testid="phone-attach-chips"]')).toBeNull();
  });

  it('takes at most five files on one message', async () => {
    const upload = vi.fn(async (file: File) => saved(file.name));
    mount(upload);
    for (let i = 0; i < 6; i += 1) {
      openMenu();
      await pick('phone-pick-photos', fileOf(`p${i}.png`, 'image/png'));
    }
    expect(upload).toHaveBeenCalledTimes(5);
    expect(note()).toContain('5 files at most');
  });

  it('a message with files keeps its text and sends the text first in the call', async () => {
    const onSend = mount(async (file) => saved(file.name));
    openMenu();
    await pick('phone-pick-photos', fileOf('a.png', 'image/png'));
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const field = host.querySelector('textarea') as HTMLTextAreaElement;
    act(() => {
      set.call(field, 'Which button is cut off?');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => send().click());
    expect(onSend).toHaveBeenCalledWith('Which button is cut off?', [saved('a.png')]);
  });
});

describe('paste', () => {
  it('turns a picture on the clipboard into a chip', async () => {
    const upload = vi.fn(async (file: File) => saved(file.name));
    mount(upload);
    const blob = new Blob(['x'], { type: 'image/png' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read: async () => [{ types: ['image/png'], getType: async () => blob }] },
    });
    openMenu();
    const paste = [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes('Paste')) as HTMLButtonElement;
    await act(async () => paste.click());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="phone-attach-chips"]')).not.toBeNull();
  });

  it('says so in one line when the browser cannot read the clipboard', async () => {
    mount(async (file) => saved(file.name));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    openMenu();
    const paste = [...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes('Paste')) as HTMLButtonElement;
    await act(async () => paste.click());
    expect(note()).toContain('Paste is not available here');
  });
});
