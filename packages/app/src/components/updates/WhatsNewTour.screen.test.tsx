// @vitest-environment jsdom
// What's new at screen level, through the real AppUpdateHost, Help menu, Feature guide and Settings block:
// the card shows once per version, the tour closes and marks the version seen, "Try it" runs the highlight's action,
// reduced motion shows stills, guide demos play only on hover or focus.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateTransport } from '../../lib/app-update';
import { rememberWhatsNew } from '../../lib/update-schedule';
import { HelpMenu } from '../whatsnew/HelpMenu';
import { FeatureGuide } from '../whatsnew/FeatureGuide';
import { WhatsNew } from '../settings/blocks/WhatsNew';
import { Demo } from '../../whatsnew/demos';
import { ACTION_EVENT, registerAction } from '../../whatsnew/registry';
import { OPEN_GUIDE_EVENT, OPEN_SHORTCUTS_EVENT, SEEN_KEY, closeTour, resetWhatsNewForTests, setRunningVersion, useWhatsNewState } from '../../whatsnew/store';
import { tourOf } from '../../whatsnew/catalog';
import { AppUpdateHost } from './AppUpdateHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  resetWhatsNewForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  closeTour();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const transport = (version: string): UpdateTransport => ({ check: vi.fn(async () => null), currentVersion: vi.fn(async () => version) }) as unknown as UpdateTransport;
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text) as HTMLButtonElement | undefined;
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));

async function mountHost(version = '1.1.1', props: { suppressed?: boolean; notify?: (t: string) => void } = {}) {
  await act(async () => root.render(<AppUpdateHost transport={transport(version)} {...props} />));
  await settle();
  await settle();
}
const note = (version = '1.1.1', chats = 0) => rememberWhatsNew({ version, notes: '- a', chats });

describe('the after-update card', () => {
  it('shows once per version: closing it marks the version seen, and a restart shows nothing', async () => {
    window.localStorage.setItem(SEEN_KEY, '1.1.0');
    note();
    const notify = vi.fn();
    await mountHost('1.1.1', { notify });
    const card = host.querySelector('[data-testid="whats-new-card"]')!;
    expect(card.getAttribute('data-mode')).toBe('highlights');
    expect(card.textContent).toContain('Updated to 1.1.1');
    expect(card.textContent).toContain('6 new things');
    expect(card.textContent).toContain('A calmer side panel, and 5 more.');
    expect(card.querySelector('[data-demo="panel"]')).not.toBeNull();
    act(() => button('Not now')!.click());
    expect(host.querySelector('[data-testid="whats-new-card"]')).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1.1.1');
    expect(notify).toHaveBeenCalledWith("Find it later under Help > What's new");
    // After a restart (the note is left again by the update): seen, so no card.
    act(() => root.unmount());
    root = createRoot(host);
    note();
    await mountHost();
    expect(host.querySelector('[data-testid="whats-new-card"]')).toBeNull();
  });

  it('shows nothing on a first install (no note was left by an update)', async () => {
    await mountHost();
    expect(host.querySelector('[data-testid="whats-new-card"]')).toBeNull();
  });

  it('waits while the first-run screens are open', async () => {
    note();
    await mountHost('1.1.1', { suppressed: true });
    expect(host.querySelector('[data-testid="whats-new-card"]')).toBeNull();
    await act(async () => root.render(<AppUpdateHost transport={transport('1.1.1')} suppressed={false} />));
    await settle();
    expect(host.querySelector('[data-testid="whats-new-card"]')).not.toBeNull();
  });

  it('keeps the "chats are back" line', async () => {
    note('1.1.1', 3);
    await mountHost();
    expect(host.querySelector('[data-testid="whats-new-card"]')?.textContent).toContain('Your 3 chats are back.');
  });

  it('falls back to the plain list, with no tour button, when the version has no highlights file', async () => {
    note('1.0.9');
    await mountHost('1.0.9');
    const card = host.querySelector('[data-testid="whats-new-card"]')!;
    expect(card.getAttribute('data-mode')).toBeNull();
    expect(card.querySelectorAll('li').length).toBe(1);
    expect(button("See what's new")).toBeUndefined();
  });

  it("See what's new opens the tour (non-blocking card is gone) and marks the version seen", async () => {
    note();
    await mountHost();
    act(() => button("See what's new")!.click());
    expect(host.querySelector('[data-testid="whats-new-card"]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('A calmer side panel');
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1.1.1');
  });
});

describe('the tour', () => {
  async function openFromCard() {
    note();
    await mountHost();
    act(() => button("See what's new")!.click());
  }

  it('walks the six cards with Next, Back and the arrow keys; Done is on the last one', async () => {
    await openFromCard();
    const dialog = () => host.querySelector('[role="dialog"]')!;
    expect(dialog().textContent).toContain('1 of 6');
    expect(document.activeElement?.textContent).toBe('Next');
    act(() => button('Next')!.click());
    expect(dialog().textContent).toContain('Drag an agent to split');
    expect(dialog().querySelector('[data-demo="split"]')).not.toBeNull();
    key('ArrowRight');
    expect(dialog().textContent).toContain('Helpers on standby');
    key('ArrowLeft');
    expect(dialog().textContent).toContain('Drag an agent to split');
    for (let i = 0; i < 4; i++) key('ArrowRight');
    expect(dialog().textContent).toContain('6 of 6');
    expect(button('Done')).toBeDefined();
    expect(button('Next')).toBeUndefined();
  });

  it.each([
    ['Skip', () => act(() => button('Skip')!.click())],
    ['Esc', () => key('Escape')],
    ['the scrim', () => act(() => void host.querySelector('.wn-scrim')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))],
  ])('%s closes it and the version stays seen', async (_name, close) => {
    await openFromCard();
    window.localStorage.removeItem(SEEN_KEY);
    close();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1.1.1');
  });

  it('Done closes it', async () => {
    await openFromCard();
    for (let i = 0; i < 5; i++) act(() => button('Next')!.click());
    act(() => button('Done')!.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Try it closes the tour and runs that highlight\'s action', async () => {
    const spy = vi.fn();
    const off = registerAction('split.hint', spy);
    await openFromCard();
    act(() => button('Next')!.click());
    act(() => button('Show me')!.click());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    off();
  });

  it('Try it with nobody to run it says so in a toast, and still closes', async () => {
    const notify = vi.fn();
    note();
    await mountHost('1.1.1', { notify });
    act(() => button("See what's new")!.click());
    const events: string[] = [];
    window.addEventListener(ACTION_EVENT, (e) => events.push((e as CustomEvent).detail.action), { once: true });
    act(() => button('Show the panel')!.click());
    expect(events).toEqual(['rail.open']);
    expect(notify).toHaveBeenCalledWith('That is not ready in this build yet. Find it in the Feature guide.');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('only the visible card has a demo, and it plays', async () => {
    await openFromCard();
    expect(host.querySelectorAll('[role="dialog"] .wn-demo').length).toBe(1);
    expect(host.querySelector('[role="dialog"] .wn-demo')?.classList.contains('play')).toBe(true);
  });

  it('with reduced motion no demo plays: the still shows', async () => {
    const mm = (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as unknown as MediaQueryList;
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: mm });
    await openFromCard();
    const demo = host.querySelector('[role="dialog"] .wn-demo')!;
    expect(demo.classList.contains('play')).toBe(false);
    expect(demo.getAttribute('data-playing')).toBe('false');
    // The card's own demo is a still too.
    expect(host.querySelector('.wn-demo.play')).toBeNull();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('gives focus back to where it was when it closes', async () => {
    await act(async () =>
      root.render(
        <>
          <button id="opener">opener</button>
          <AppUpdateHost transport={transport('1.1.1')} />
        </>,
      ),
    );
    await settle();
    const opener = host.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();
    act(() => void import('../../whatsnew/store').then((s) => s.openTour('1.1.1')));
    await settle();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    key('Escape');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('demos', () => {
  it('an unknown demo name draws the fallback tile, never an empty box', () => {
    act(() => root.render(<Demo name="no-such-demo" area="Files" play />));
    const tile = host.querySelector('.wn-demo')!;
    expect(tile.getAttribute('data-demo')).toBe('fallback');
    expect(tile.textContent).toBe('F');
  });

  it('every demo of the 1.1.1 tour is built from boxes (the still is the base style)', () => {
    for (const h of tourOf('1.1.1')) {
      act(() => root.render(<Demo name={h.demo} play={false} />));
      const demo = host.querySelector('.wn-demo')!;
      expect(demo.className, h.id).not.toContain('play');
      expect(demo.querySelectorAll('i').length, h.id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the Feature guide', () => {
  it('lists the features by area with a New tag, and demos are stills until hovered or focused', () => {
    setRunningVersion('1.1.1');
    act(() => root.render(<FeatureGuide />));
    expect(host.textContent).toContain('Feature guide');
    expect(host.textContent).toContain('Everything the app can do, with a short demo of each. Point at a card to play it.');
    expect(host.querySelectorAll('.wn-gcard').length).toBe(11);
    expect(host.querySelector('.wn-demo.play')).toBeNull();
    const card = host.querySelector<HTMLElement>('[data-id="split-drag"]')!;
    expect(card.textContent).toContain('New');
    expect(host.querySelector('[data-id="keep-going"]')?.textContent).not.toContain('New');
    act(() => void card.dispatchEvent(new Event('focus', { bubbles: false })));
    // React listens to focusin for onFocus.
    act(() => void card.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(card.querySelector('.wn-demo')?.classList.contains('play')).toBe(true);
    expect(host.querySelectorAll('.wn-demo.play').length).toBe(1);
    act(() => void card.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })));
    expect(host.querySelector('.wn-demo.play')).toBeNull();
  });

  it('searches on title and line, and says when nothing matches', () => {
    act(() => root.render(<FeatureGuide />));
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const type = (v: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setter.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('word');
    expect(Array.from(host.querySelectorAll('.wn-gcard')).map((c) => (c as HTMLElement).dataset.id)).toEqual(['word-pages']);
    type('zzzz');
    expect(host.querySelector('.wn-gcard')).toBeNull();
    expect(host.textContent).toContain('No feature matches that.');
  });

  it('Try it runs the card\'s action; the header button opens the tour', () => {
    const spy = vi.fn();
    const off = registerAction('usage.open', spy);
    act(() => root.render(<FeatureGuide />));
    act(() => void host.querySelector<HTMLButtonElement>('[data-id="usage-button"] .wn-gtry')!.click());
    expect(spy).toHaveBeenCalled();
    off();
  });
});

describe('where it is reached from', () => {
  function TourState() {
    const s = useWhatsNewState();
    return <output data-testid="tour">{s.tour ? s.tour.version : 'closed'}</output>;
  }

  it('Help > What\'s new opens the tour, with the version pill until seen', () => {
    setRunningVersion('1.1.1');
    act(() =>
      root.render(
        <>
          <HelpMenu />
          <TourState />
        </>,
      ),
    );
    act(() => void host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!.click());
    const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent);
    expect(items).toEqual(["What's new1.1.1", 'Feature guide', 'Keyboard shortcuts']);
    act(() => void (Array.from(document.querySelectorAll('[role="menuitem"]'))[0] as HTMLElement).click());
    expect(host.querySelector('[data-testid="tour"]')?.textContent).toBe('1.1.1');
    // Now it is seen: reopening the menu has no pill.
    act(() => void host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!.click());
    expect(document.querySelectorAll('[role="menuitem"]')[0].textContent).toBe("What's new");
  });

  it('Help > Feature guide and Keyboard shortcuts ask the cockpit for those pages', () => {
    const got: string[] = [];
    const a = () => got.push('guide');
    const b = () => got.push('shortcuts');
    window.addEventListener(OPEN_GUIDE_EVENT, a);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, b);
    act(() => root.render(<HelpMenu />));
    act(() => void host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!.click());
    act(() => void (Array.from(document.querySelectorAll('[role="menuitem"]'))[1] as HTMLElement).click());
    act(() => void host.querySelector<HTMLButtonElement>('button[aria-label="Help"]')!.click());
    act(() => void (Array.from(document.querySelectorAll('[role="menuitem"]'))[2] as HTMLElement).click());
    expect(got).toEqual(['guide', 'shortcuts']);
    window.removeEventListener(OPEN_GUIDE_EVENT, a);
    window.removeEventListener(OPEN_SHORTCUTS_EVENT, b);
  });

  it('Settings > General > What\'s new has Take the tour and Open the feature guide', () => {
    setRunningVersion('1.1.1');
    const got: string[] = [];
    const a = () => got.push('guide');
    window.addEventListener(OPEN_GUIDE_EVENT, a);
    act(() =>
      root.render(
        <>
          <WhatsNew env={{} as never} />
          <TourState />
        </>,
      ),
    );
    act(() => void button('Take the tour')!.click());
    expect(host.querySelector('[data-testid="tour"]')?.textContent).toBe('1.1.1');
    act(() => void button('Open the feature guide')!.click());
    expect(got).toEqual(['guide']);
    window.removeEventListener(OPEN_GUIDE_EVENT, a);
  });
});
