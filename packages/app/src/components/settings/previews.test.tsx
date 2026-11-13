// @vitest-environment jsdom
// The small pictures and test buttons of the rows: the theme thumbnails, the mode switch frame, the usage sample,
// and "Send a test".
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_SETTINGS, click, makeEnv, settle } from './test-utils';
import { ModeSwitchFrame, SendTest, UsageSample } from './previews/Previews';
import { LayoutThumbs, ThemeThumbs } from './previews/Thumbs';
import { ROW_META } from './row-meta';

let host: HTMLDivElement;
let root: Root;

async function draw(node: ReactNode) {
  await act(async () => root.render(node));
  await settle(2);
}

function reduceMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: on && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  reduceMotion(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('Theme', () => {
  it('Theme shows two thumbnails and marks the chosen one', async () => {
    const picked: string[] = [];
    await draw(<ThemeThumbs value="light" onPick={(t) => picked.push(t)} />);
    const radios = [...host.querySelectorAll('[role="radiogroup"][aria-label="Theme"] [role="radio"]')];
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Dark', 'Light']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(radios.every((r) => r.querySelector('svg'))).toBe(true); // each one is a small picture of a window
    await click(radios[0]);
    expect(picked).toEqual(['dark']);
    await click(radios[1]); // the chosen one does not save again
    expect(picked).toEqual(['dark']);
  });

  it('Window layout shows a diagram for each choice', async () => {
    await draw(<LayoutThumbs value="cascade" onPick={() => undefined} />);
    const radios = [...host.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(['Side by side', 'Cascade']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });
});

describe('Mode switch animation', () => {
  const frame = () => host.querySelector('.st-mode-frame') as HTMLElement;

  it('Mode switch animation plays once on change and not at all with reduce motion', async () => {
    await draw(<ModeSwitchFrame style="domino" />);
    expect(frame().getAttribute('data-playing')).toBeNull(); // nothing plays just from opening the page
    await draw(<ModeSwitchFrame style="ink" />);
    expect(frame().getAttribute('data-playing')).toBe('ink'); // the new choice plays once
    await click(host.querySelector('button.st-mode-frame')); // the picture itself is the play button
    expect(frame().getAttribute('data-playing')).toBe('ink'); // Play runs it again

    reduceMotion(true);
    await draw(<ModeSwitchFrame style="off" />);
    expect(frame().getAttribute('data-playing')).toBeNull();
    await click(host.querySelector('button.st-mode-frame'));
    expect(frame().getAttribute('data-playing')).toBeNull();
  });
});

describe('Show usage bar', () => {
  it('Usage bar shows the sample only while the switch is on', async () => {
    const preview = ROW_META['usage-bar'].preview!;
    await draw(<>{preview(makeEnv({ settings: { ...BASE_SETTINGS, show_usage_bar: true } }))}</>);
    expect(host.querySelector('.st-usage-sample')?.textContent).toContain('Example');
    await draw(<>{preview(makeEnv({ settings: { ...BASE_SETTINGS, show_usage_bar: false } }))}</>);
    expect(host.querySelector('.st-usage-sample')).toBeNull();
    await draw(<UsageSample />);
    expect(host.querySelectorAll('.st-usage-line')).toHaveLength(2);
  });
});

describe('Send a test', () => {
  it('Send a test is disabled with a plain reason when there is nothing to send to', async () => {
    const send = vi.fn(async () => ({ ok: true, message: 'Sent' }));
    await draw(<SendTest disabledReason="Pair a phone first" send={send} />);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a test') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain('Pair a phone first');
    await click(button);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one test and shows the result as one line, or the plain error', async () => {
    const send = vi.fn<() => Promise<{ ok: boolean; message: string }>>().mockResolvedValueOnce({ ok: true, message: 'Sent' }).mockResolvedValueOnce({ ok: false, message: 'Discord says no.' });
    await draw(<SendTest send={send} />);
    const button = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a test') as HTMLButtonElement;
    await click(button());
    await settle(2);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Sent');
    await click(button());
    await settle(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Discord says no.');
    expect(host.querySelector('[role="status"]')).toBeNull(); // one line at a time
  });
});
