// @vitest-environment jsdom
// A huge paste must not freeze the box: over the hard cap it is refused with a sentence; a big one under it is typed in
// without per-change scans or a forced layout of all of it. (Real browser: 207,500 chars took 5.7 s, 830,000 took 176 s.)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';
import { PASTE_MAX_CHARS, refusePaste } from '../../lib/bigText';
import { t } from '../../i18n';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ChatComposer onSend={async () => null} blockedReason={null} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const field = () => host.querySelector('textarea') as HTMLTextAreaElement;

function paste(text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
  event.clipboardData = { files: [], getData: () => text };
  act(() => {
    field().dispatchEvent(event);
  });
  return event;
}

describe('huge paste', () => {
  it('refuses text over the cap with a plain sentence', () => {
    const event = paste('x'.repeat(PASTE_MAX_CHARS + 1));
    expect(event.defaultPrevented).toBe(true);
    expect(host.textContent).toContain(t('r12ui.paste.tooBig'));
  });

  it('leaves a normal paste alone', () => {
    expect(paste('hello').defaultPrevented).toBe(false);
    expect(refusePaste({ clipboardData: null, preventDefault: () => undefined })).toBe(false);
  });

  it('takes 300k characters in a change quickly', () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const started = performance.now();
    act(() => {
      set.call(field(), '@a'.repeat(150_000));
      field().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(field().value.length).toBe(300_000);
  });
});
