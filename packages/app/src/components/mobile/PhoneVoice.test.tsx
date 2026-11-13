// @vitest-environment jsdom
// P15 on the phone: tap the mic and the words appear in the box with a wave and a clock; the tick keeps them, the cross puts the
// box back; nothing is sent until Send. Where the phone cannot recognize speech on the device, the mic says so in one line.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../i18n';
import { PhoneComposer } from './PhoneComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let instance: FakeRecognizer | null = null;

class FakeRecognizer {
  lang = '';
  continuous = false;
  interimResults = false;
  processLocally = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  static available = vi.fn(async () => 'available');
  constructor() {
    instance = this;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.onend?.();
  }
  say(text: string, isFinal: boolean) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  instance = null;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
});

async function mount(onSend = vi.fn(async () => null as string | null)) {
  await act(async () => {
    root.render(<PhoneComposer onSend={onSend} blockedReason={null} draftKey="p1" model="Sonnet 5" />);
  });
  await act(async () => undefined);
  return onSend;
}

const mic = () => host.querySelector('[data-testid="phone-mic"]') as HTMLButtonElement;
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;
const bar = () => host.querySelector('[data-testid="phone-voice-bar"]');
function tapMic() {
  act(() => {
    mic().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}
function typeText(text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('voice typing', () => {
  it('shows the wave, the live words and a clock while it listens, and the words land in the box', async () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognizer;
    await mount();
    tapMic();
    expect(instance?.started).toBe(true);
    expect(instance?.processLocally).toBe(true);
    expect(bar()).not.toBeNull();
    expect(bar()!.querySelectorAll('.ph-wave i').length).toBeGreaterThan(0);
    expect(bar()!.textContent).toContain('0:00');
    act(() => instance!.say('run the', false));
    expect(bar()!.textContent).toContain('run the');
    act(() => instance!.say('run the tests', true));
    expect(field().value).toBe('run the tests');
  });

  it('the tick keeps the words in the box and sends nothing; Send stays off while listening', async () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognizer;
    const onSend = await mount();
    typeText('Please');
    tapMic();
    act(() => instance!.say('run the tests', true));
    expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    act(() => (host.querySelector('[data-testid="phone-voice-keep"]') as HTMLButtonElement).click());
    expect(bar()).toBeNull();
    expect(field().value).toBe('Please run the tests');
    expect(onSend).not.toHaveBeenCalled();
    expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the cross puts the box back as it was before the words', async () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognizer;
    const onSend = await mount();
    typeText('Please');
    tapMic();
    act(() => instance!.say('something wrong', true));
    expect(field().value).toBe('Please something wrong');
    act(() => (host.querySelector('[data-testid="phone-voice-drop"]') as HTMLButtonElement).click());
    expect(bar()).toBeNull();
    expect(field().value).toBe('Please');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('says in one line that voice typing is not available where the phone cannot do it on the device', async () => {
    await mount();
    tapMic();
    expect(bar()).toBeNull();
    const line = host.querySelector('[data-testid="phone-mic-note"]');
    expect(line?.textContent).toContain('Voice typing is not available on this phone');
    expect(line?.textContent).toContain("keyboard's mic");
  });

  it('the wave stops under reduced motion', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '../../styles/phone-compose.css'), 'utf8').replace(/\r\n/g, '\n');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.ph-wave i/);
    expect(block).toMatch(/animation:\s*none/);
  });
});
