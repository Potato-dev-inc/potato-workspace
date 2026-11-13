import { PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// Shared by the phone-compose evidence scenarios (attach menu and chip, voice, quick replies, result card, progress line).
// No default export, so the registry skips this file.
export type ComposeShot = 'result' | 'resultfull' | 'menu' | 'chip' | 'voice' | 'progress' | 'drawer';

/** Every pane idle except `busy`, so the app lands on the chat of this shot. */
function panesWith(busy: string | null) {
  return PHONE_PANES.map((p) => ({ ...p, status: p.id === busy ? ('running' as const) : ('idle' as const) }));
}

function setBox(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>('[data-testid="phone-composer"] textarea');
  if (!field) return;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  set.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A file picked in the "Photos" input, as the phone's picker would hand it over. */
function pickPhoto() {
  const input = document.querySelector<HTMLInputElement>('[data-testid="phone-pick-photos"]');
  if (!input) return;
  const file = new File([new Uint8Array(1_258_291)], 'screenshot.jpg', { type: 'image/jpeg' });
  const list = new DataTransfer();
  list.items.add(file);
  input.files = list.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** An on-device speech recognizer that says a few words, for the voice shot. */
function installSpeech() {
  class Fake {
    lang = '';
    continuous = false;
    interimResults = false;
    processLocally = false;
    onresult: ((event: unknown) => void) | null = null;
    onerror: (() => void) | null = null;
    onend: (() => void) | null = null;
    static available = async () => 'available';
    constructor() {
      (window as unknown as { __rec: Fake }).__rec = this;
    }
    start() {}
    stop() {
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
  }
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = Fake;
}

export function phoneComposeScenario(shot: ComposeShot, theme: 'dark' | 'light'): HarnessScenario {
  const live = shot === 'progress' || shot === 'drawer';
  const chat = live ? 'live' : shot === 'menu' || shot === 'chip' ? 'asking' : 'finished';
  return {
    name: `phone-compose-${shot}-${theme}`,
    route: 'phone',
    window: { width: 390, height: 844 },
    theme,
    phonePanes: panesWith(live ? PANE_CODEX : null),
    phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, chat },
    after: async (dom) => {
      await dom.waitFor('.ph-conv');
      await dom.sleep(700);
      if (shot === 'resultfull') {
        await dom.click('.ph-result-body');
        await dom.waitFor('[data-testid="phone-result-screen"]');
        await dom.sleep(700);
      }
      if (shot === 'menu') {
        await dom.click('[aria-label="Add"]');
        await dom.waitFor('[data-testid="phone-plus-menu"]');
        await dom.sleep(400);
      }
      if (shot === 'chip') {
        await dom.click('[aria-label="Add"]');
        await dom.waitFor('[data-testid="phone-plus-menu"]');
        pickPhoto();
        await dom.waitFor('[data-testid="phone-attach-chips"]');
        setBox('Which button is cut off?');
        await dom.sleep(700);
      }
      if (shot === 'drawer') {
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(500);
      }
      if (shot === 'voice') {
        // The recognizer is checked when the box opens: install it, go to another chat and back so the box opens again.
        installSpeech();
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(300);
        await dom.clickText('.ph-drow', PHONE_PANES.find((p) => p.id === PANE_CLAUDE)?.title ?? 'Fix login redirect');
        await dom.sleep(500);
        await dom.click('.ph-head-menu');
        await dom.waitFor('.ph-drawer');
        await dom.sleep(300);
        await dom.clickText('.ph-drow', PHONE_PANES.find((p) => p.id === PANE_CODEX)?.title ?? 'Billing tests');
        await dom.waitFor('[data-testid="phone-composer"] textarea');
        await dom.sleep(600);
        setBox('Please');
        document.querySelector<HTMLElement>('[data-testid="phone-mic"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await dom.sleep(300);
        const rec = (window as unknown as { __rec?: { onresult: ((e: unknown) => void) | null } }).__rec;
        rec?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'run the tests and tell me' } }, { isFinal: false, 0: { transcript: 'what fails' } }] });
        await dom.sleep(600);
      }
    },
  };
}
