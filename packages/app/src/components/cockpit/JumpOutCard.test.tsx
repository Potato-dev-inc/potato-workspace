// @vitest-environment jsdom
// The jump-out card: a blocking question that only the Inbox shows pops over the work area, with the Inbox's own words and
// routes, and never takes the keyboard. "Later" hides it and leaves the question in the Inbox. Rules themselves: lib/jump-out.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { FarNeedsContext, NeedsYouContext, type FarNeeds } from '../../hooks/useNeedsYou';
import type { NeedsYouItem } from '../../lib/attention';
import type { Question } from '../../lib/questions';
import type { FarQuestion } from '../../lib/runtime/farQuestions';
import { JumpOutCard } from './JumpOutCard';
import { Inbox } from './Inbox';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));
const setting = vi.hoisted(() => ({ on: true }));
vi.mock('../../lib/jump-out-setting', () => ({ useJumpOutEnabled: () => setting.on }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(1_700_000_000_000);
  setting.on = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const NOW = 1_700_000_000_000;
const HELPER: Question = {
  id: 'h1', pane_id: 'helper1', kind: 'helper_login', question: 'Which login should this Claude helper use?',
  choices: [{ id: 'once:main', label: 'Main login' }, { id: 'always:main', label: 'Always use Main login' }],
  allow_free_text: false, urgency: 'normal', created_at_ms: NOW - 1000, expires_at_ms: NOW + 600_000, state: 'pending',
};
const ASK: Question = { id: 'a1', question: 'Which branch?', choices: [], allow_free_text: true, urgency: 'normal', created_at_ms: NOW - 500, expires_at_ms: NOW + 600_000, state: 'pending' };

function fakeApi(questions: Question[], over: Partial<CockpitApi> = {}): CockpitApi {
  const pane = { info: { id: 'helper1', agent_type: 'claude', pid: 1, status: 'running', created_at: 1, last_output_at: null, cwd: 'C:\\work\\proj', cols: 80, rows: 24, title: null }, status: 'running' };
  return {
    registry: { paneList: [pane], panes: new Map([['helper1', pane]]), initialReady: true },
    names: new Map(),
    asked: { questions, answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: NOW,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    bridgeLine: '',
    interrupt: vi.fn(),
    ...over,
  } as unknown as CockpitApi;
}

type Props = Partial<Parameters<typeof JumpOutCard>[0]>;
async function mount(c: CockpitApi, props: Props = {}, far: FarNeeds | null = null, needs: NeedsYouItem[] | null = null) {
  const tree = (p: Props, cc: CockpitApi) => (
    <NeedsYouContext.Provider value={needs}>
      <FarNeedsContext.Provider value={far}>
        <JumpOutCard c={cc} view="pane" shown={[]} farOpen={null} onOpenInbox={vi.fn()} {...p} />
      </FarNeedsContext.Provider>
    </NeedsYouContext.Provider>
  );
  await act(async () => root.render(tree(props, c)));
  return { rerender: (cc: CockpitApi, p: Props = props) => act(async () => root.render(tree(p, cc))) };
}
const grace = () => act(async () => void vi.advanceTimersByTime(3200));
const card = () => host.querySelector<HTMLElement>('.ck-jumpout');
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('JumpOutCard', () => {
  // Real geometry stubs (jsdom has no layout) on the classes the app really renders: ChatComposer's .ck-chat-composer (local AND
  // far chats use it) and the new-agent page's .ck-na-composer. The rule: the card's bottom edge is never below the composer's top.
  const rect = (r: Partial<DOMRect>) => () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...r }) as DOMRect;
  async function place(composerClass: string, composerRect: Partial<DOMRect>, railRect?: Partial<DOMRect>) {
    const stage = document.createElement('div');
    stage.className = 'cockpit';
    stage.getBoundingClientRect = rect({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
    const composer = document.createElement('div');
    composer.className = composerClass;
    composer.getBoundingClientRect = rect(composerRect);
    stage.append(composer);
    if (railRect) {
      const rail = document.createElement('div');
      rail.className = 'ck-rail';
      rail.getBoundingClientRect = rect(railRect);
      stage.append(rail);
    }
    stage.append(host);
    document.body.append(stage);
    await mount(fakeApi([HELPER]));
    await grace();
    return { style: card()!.style, stage };
  }
  const px = (style: CSSStyleDeclaration, k: string) => parseInt(style.getPropertyValue(k), 10);

  for (const cls of ['ck-chat-composer', 'ck-na-composer']) {
    it(`sits above the message box (${cls}) and inside its column, never over it`, async () => {
      const { style, stage } = await place(cls, { top: 618, bottom: 771, left: 398, right: 993, width: 595, height: 153 }, { left: 1017, right: 1280, top: 40, bottom: 800, width: 263, height: 760 });
      // 800 - 618 + 8 = 190; the card's bottom edge (800 - 190 = 610) is above the composer's top (618).
      expect(px(style, '--jo-bottom')).toBe(190);
      expect(800 - px(style, '--jo-bottom')).toBeLessThanOrEqual(618);
      expect(px(style, '--jo-right')).toBe(1280 - 993 + 16); // aligned to the column, so left of the right panel
      expect(1280 - px(style, '--jo-right')).toBeLessThanOrEqual(1017);
      expect(card()!.hasAttribute('data-compact')).toBe(false);
      stage.remove();
    });
  }

  it('measures in CSS pixels when the page is zoomed (Text size): window pixels divided by the zoom', async () => {
    document.documentElement.style.setProperty('--ui-scale', '1.25');
    try {
      const { style, stage } = await place('ck-chat-composer', { top: 625, bottom: 775, left: 400, right: 1000, width: 600, height: 150 });
      expect(px(style, '--jo-bottom')).toBe((800 - 625) / 1.25 + 8);
      expect(px(style, '--jo-right')).toBe((1280 - 1000) / 1.25 + 16);
      stage.remove();
    } finally {
      document.documentElement.style.removeProperty('--ui-scale');
    }
  });

  it('follows a panel that moves without resizing (a slow tick looks again)', async () => {
    const { style, stage } = await place('ck-chat-composer', { top: 618, bottom: 771, left: 398, right: 993, width: 595, height: 153 });
    stage.querySelector<HTMLElement>('.ck-chat-composer')!.getBoundingClientRect = rect({ top: 500, bottom: 650, left: 398, right: 900, width: 502, height: 150 });
    await act(async () => void vi.advanceTimersByTime(500));
    expect(px(style, '--jo-bottom')).toBe(800 - 500 + 8);
    expect(px(style, '--jo-right')).toBe(1280 - 900 + 16);
    stage.remove();
  });

  it('with little room above the message box it is one line, and "Show" opens the card', async () => {
    const { stage } = await place('ck-chat-composer', { top: 150, bottom: 780, left: 398, right: 993, width: 595, height: 630 });
    expect(card()!.hasAttribute('data-compact')).toBe(true);
    expect(host.querySelector('.ib-dock')).toBeNull();
    await act(async () => button('Show')!.click());
    expect(host.querySelector('.ib-dock')).not.toBeNull();
    stage.remove();
  });

  it('never reaches over the sidebar: a column that starts under it is clamped, and a narrow one shows the line only, with Show opening the Inbox', async () => {
    const stage = document.createElement('div');
    stage.className = 'cockpit';
    stage.getBoundingClientRect = rect({ left: 0, top: 0, right: 1280, bottom: 820, width: 1280, height: 820 });
    const side = document.createElement('aside');
    side.className = 'ck-side';
    side.getBoundingClientRect = rect({ left: 0, top: 0, right: 376, bottom: 820, width: 376, height: 820 });
    const composer = document.createElement('div');
    composer.className = 'ck-chat-composer';
    // The chat column starts left of the sidebar's edge and ends at 500: only 124px of it is really the chat's.
    composer.getBoundingClientRect = rect({ top: 700, bottom: 800, left: 300, right: 500, width: 200, height: 100 });
    stage.append(side, composer, host);
    document.body.append(stage);
    const onOpenInbox = vi.fn();
    await mount(fakeApi([HELPER]), { onOpenInbox });
    await grace();
    const style = card()!.style;
    const right = 1280 - px(style, '--jo-right');
    const left = right - px(style, '--jo-col');
    expect(left).toBeGreaterThanOrEqual(376);
    expect(card()!.hasAttribute('data-mini')).toBe(true);
    expect(card()!.hidden).toBe(false);
    // The title text is gone; Show and Later are icon buttons on one row, still named.
    expect(card()!.querySelectorAll('.ck-jumpout-line > button')).toHaveLength(2);
    expect(card()!.querySelector('.ck-jumpout-line [aria-label="Needs you now"]')).not.toBeNull();
    await act(async () => card()!.querySelector<HTMLButtonElement>('button[aria-label="Show"]')!.click());
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.ib-dock')).toBeNull();
    stage.remove();
  });

  it('with no message box (Inbox, terminal) it clears the right panel and falls back to the CSS bottom', async () => {
    const stage = document.createElement('div');
    stage.className = 'cockpit';
    stage.getBoundingClientRect = rect({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 });
    const rail = document.createElement('div');
    rail.className = 'ck-rail';
    rail.getBoundingClientRect = rect({ left: 980, right: 1280, top: 40, bottom: 800, width: 300, height: 760 });
    stage.append(rail, host);
    document.body.append(stage);
    await mount(fakeApi([HELPER]));
    await grace();
    expect(card()!.style.getPropertyValue('--jo-bottom')).toBe('');
    expect(px(card()!.style, '--jo-right')).toBe(316);
    stage.remove();
  });

  it('shows the helper-login card with the Inbox words and no Dismiss; "Main login" answers once:main', async () => {
    const c = fakeApi([HELPER]);
    await mount(c);
    expect(card()).toBeNull(); // the 3 s grace
    await grace();
    expect(card()!.getAttribute('role')).toBe('region');
    expect(card()!.getAttribute('aria-live')).toBe('polite');
    expect(card()!.textContent).toContain('Which login should this Claude helper use?');
    expect(host.querySelector('[data-ib="dismiss"]')).toBeNull();
    await act(async () => button('Main login')!.click());
    expect(c.asked.answerQuestion).toHaveBeenCalledWith('h1', { choice_id: 'once:main' });
  });

  it('"Later" hides it without dismissing the question, and the Inbox still lists it', async () => {
    const c = fakeApi([HELPER]);
    await mount(c);
    await grace();
    expect(button('Later')!.title).toBe('Hide this. It stays in your Inbox.');
    await act(async () => button('Later')!.click());
    expect(card()).toBeNull();
    expect(c.asked.dismissQuestion).not.toHaveBeenCalled();
    // The Inbox, drawn from the same state, still holds the card.
    await act(async () => root.render(<Inbox c={c} />));
    expect(host.textContent).toContain('Which login should this Claude helper use?');
  });

  it('draws nothing in the Inbox view, with the setting off, or in individual mode', async () => {
    const c = fakeApi([HELPER]);
    const { rerender } = await mount(c);
    await grace();
    expect(card()).not.toBeNull();
    await rerender(c, { view: 'inbox' });
    expect(card()).toBeNull();
    await rerender(c, { view: 'settings' });
    expect(card()).toBeNull();
    await rerender(c, { view: 'pane' });
    expect(card()).not.toBeNull();
    setting.on = false;
    await rerender(c);
    expect(card()).toBeNull();
    setting.on = true;
    await rerender(fakeApi([HELPER], { mode: 'individual' } as Partial<CockpitApi>));
    expect(card()).toBeNull();
  });

  it('a permission of a pane that is on screen is left to that pane', async () => {
    const perm: Question = { ...ASK, id: 'p1', kind: 'acp_permission', pane_id: 'helper1', allow_free_text: false, choices: [{ id: 'y', label: 'Yes' }] };
    await mount(fakeApi([perm]), { shown: ['helper1'] });
    await grace();
    expect(card()).toBeNull();
  });

  it('keeps the keyboard where it was: a new question arriving never moves focus, and the card is not swapped under typed text', async () => {
    const term = document.createElement('textarea');
    document.body.appendChild(term);
    term.focus();
    const first = fakeApi([ASK]);
    const { rerender } = await mount(first);
    await grace();
    expect(document.activeElement).toBe(term);
    expect(card()!.textContent).toContain('Which branch?');

    // The person types into the card: a calmer-ranked first-in-line question (older) must not replace it.
    const input = card()!.querySelector<HTMLInputElement>('input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      input.focus();
      setter.call(input, 'main');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const older: Question = { ...ASK, id: 'a0', question: 'Older question?', created_at_ms: NOW - 9000 };
    await rerender(fakeApi([ASK, older]));
    await grace();
    expect(card()!.textContent).toContain('Which branch?');
    expect(card()!.querySelector<HTMLInputElement>('input')!.value).toBe('main');
    expect(button('1 more in Inbox >')).toBeTruthy();
    term.remove();
  });

  it('with no field in use the first question in Inbox order shows, and "N more in Inbox >" opens the Inbox', async () => {
    const onOpenInbox = vi.fn();
    const older: Question = { ...ASK, id: 'a0', question: 'Older question?', created_at_ms: NOW - 9000 };
    await mount(fakeApi([ASK, older]), { onOpenInbox });
    await grace();
    expect(card()!.textContent).toContain('Older question?');
    expect(card()!.textContent).not.toContain('Which branch?');
    await act(async () => button('1 more in Inbox >')!.click());
    expect(onOpenInbox).toHaveBeenCalled();
  });

  it('a far question shows with the host line and answers through farNeeds.answer, never hide', async () => {
    const farQ: FarQuestion = { key: 'dev:n1:f1', node: 'n1', pcName: 'Work PC', id: 'f1', question: 'Run it?', choices: [{ id: 'y', label: 'Yes' }], allowFreeText: false, waitMs: 60_000, seenAt: NOW };
    const answer = vi.fn(async () => undefined);
    const hide = vi.fn();
    await mount(fakeApi([]), {}, { questions: [farQ], answer, hide }, [{ id: 'question:dev:n1:f1', kind: 'question', since: NOW }]);
    await grace();
    expect(card()!.textContent).toContain('Run it?');
    expect(card()!.textContent).toContain('On Work PC');
    expect(host.querySelector('[data-ib="dismiss"]')).toBeNull();
    await act(async () => button('Yes')!.click());
    expect(answer).toHaveBeenCalledWith('dev:n1:f1', { choice_id: 'y' });
    expect(hide).not.toHaveBeenCalled();
  });

  it('never imports the PC link or listens on the document', () => {
    const text = readFileSync(join(__dirname, 'JumpOutCard.tsx'), 'utf8');
    expect(text).not.toMatch(/runtime\/(pclink|remote)/);
    expect(text).not.toMatch(/addEventListener|useDismissable|autoFocus=\{(?!false)/);
  });
});
