// @vitest-environment jsdom
// Screen level: the companion speaks first (off by default, quiet budget, typing, quiet hours, asleep, Too much) and
// Potato is dropped on an agent (note once, two lines, Watch / Nudge / Thanks, terminal fallback).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsYouItem } from '../../../lib/attention';
import type { CompanionView } from '../../../lib/companion';
import { SPEAK_KEY, SPEAK_DEFAULTS, reloadSpeakForTests, getSpeak } from '../../../lib/companionSpeak';
import { setLanguagePref } from '../../../i18n';
import { useChinese, visibleEnglish } from '../../../i18n/test-utils';
import { NOTED_KEY, registerPaneTurns } from '../../../lib/potatoCheck';
import type { SideQuestionApi } from '../../../lib/sideQuestion';
import type { ChatTurn } from '../../../lib/sessionChatModel';
import { DragLayer } from '../../dnd/DragLayer';
import { cancelDrag } from '../../dnd/dragStore';
import { CompanionRow } from './CompanionRow';
import { CompanionAssist, OFFER_DELAY_MS, type CompanionAssistProps } from './CompanionAssist';

const quiet = vi.hoisted(() => ({ value: { enabled: false, start: 22 * 60, end: 7 * 60 } }));
vi.mock('../../../lib/notify-store', () => ({ readQuiet: () => quiet.value }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companion: CompanionView = {
  id: 'mochi', name: 'Mochi', avatar: 'mochi', persona: 'calm', agentType: 'claude', agentLabel: 'Claude', folderName: 'c', state: 'idle',
  stateLine: '', paneId: 'companion-mochi', needs: null, pendingMemory: 0, nextCheckin: null, restarts: 0, autoStart: true,
};
const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime();

let host: HTMLDivElement;
let root: Root;
let offs: Array<() => void> = [];

function setSpeakSaved(value: object): void {
  localStorage.setItem(SPEAK_KEY, JSON.stringify(value));
  reloadSpeakForTests();
}

beforeEach(() => {
  localStorage.clear();
  reloadSpeakForTests();
  quiet.value = { enabled: false, start: 22 * 60, end: 7 * 60 };
  setLanguagePref('en', false);
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOON);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  // Rows sit one under the other, each 200 x 30.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const row = this.getAttribute('data-pane-row');
    const top = this.classList.contains('ck-companion-row') ? 0 : row === 'p1' ? 100 : row === 'p2' ? 140 : 0;
    const has = this.classList.contains('ck-companion-row') || row;
    const w = has ? 200 : 0;
    return { left: 0, right: w, top, bottom: has ? top + 30 : 0, width: w, height: has ? 30 : 0, x: 0, y: top, toJSON() {} } as DOMRect;
  });
});
afterEach(() => {
  act(() => cancelDrag());
  act(() => root.unmount());
  offs.forEach((off) => off());
  offs = [];
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLanguagePref('auto', false);
});

const waitingItem = (paneId: string, minutes: number, kind: NeedsYouItem['kind'] = 'approval'): NeedsYouItem => ({ id: `${kind}:${paneId}`, kind, paneId, since: NOON - minutes * 60_000 });

function props(over: Partial<CompanionAssistProps> = {}): CompanionAssistProps {
  return {
    companion,
    needsYou: [],
    panes: [{ id: 'p1', status: 'running' }, { id: 'p2', status: 'running' }],
    nameOf: (id) => (id === 'p1' ? 'Claude 2' : 'Codex'),
    activityOf: (id) => (id === 'p2' ? 'Editing app.ts' : null),
    onOpenPane: vi.fn(),
    onOpenInbox: vi.fn(),
    onNudge: vi.fn(),
    ...over,
  };
}

async function render(p: CompanionAssistProps) {
  await act(async () => {
    root.render(
      <>
        <CompanionRow companion={companion} mood={{ face: 'idle', key: 'companion.mood.here', urgent: false }} active={false} onOpen={() => {}} />
        <button type="button" data-pane-row="p1">Claude 2</button>
        <button type="button" data-pane-row="p2">Codex</button>
        <textarea data-testid="field" />
        <DragLayer />
        <CompanionAssist {...p} />
      </>,
    );
  });
}
const rerender = render;
const settle = () => act(async () => void vi.advanceTimersByTime(20));
const text = () => host.textContent ?? '';
const fire = (target: EventTarget, type: string, x: number, y: number) =>
  act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
const find = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
// A person's click starts with a press (the drag layer swallows the click that ends a drag until the next press).
const button = (label: string) => {
  const el = find(label);
  return { click: () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); el.click(); } };
};

describe('the companion speaks first', () => {
  it('says nothing by default, even when an agent has waited long', async () => {
    await render(props({ needsYou: [waitingItem('p1', 12)] }));
    await settle();
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('when on, says who waited and for what, with Open / Later / Too much', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    const p = props({ needsYou: [waitingItem('p1', 12)] });
    await render(p);
    const bubble = host.querySelector('[data-testid="speak-bubble"]')!;
    expect(bubble.textContent).toContain('Claude 2 has waited 12 minutes for a yes or no.');
    expect(bubble.getAttribute('role')).toBe('status');
    expect([...bubble.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open', 'Later', 'Too much']);
    await act(async () => button('Open').click());
    expect(p.onOpenPane).toHaveBeenCalledWith('p1');
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('waits until an agent has waited ten minutes', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    await render(props({ needsYou: [waitingItem('p1', 9)] }));
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('Too much halves the budget and closes the bubble', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    await render(props({ needsYou: [waitingItem('p1', 12)] }));
    await act(async () => button('Too much').click());
    expect(getSpeak().perHour).toBe(1);
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('Later hides the bubble and Esc does the same', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    await render(props({ needsYou: [waitingItem('p1', 12)] }));
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('stays silent while the person types', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    await render(props());
    await act(async () => void host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    await render(props({ needsYou: [waitingItem('p1', 12)] }));
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(9_000 + 15_000));
    expect(host.querySelector('[data-testid="speak-bubble"]')).not.toBeNull();
  });

  it('stays silent in quiet hours and while the companion sleeps', async () => {
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    quiet.value = { enabled: true, start: 0, end: 1439 };
    await render(props({ needsYou: [waitingItem('p1', 12)] }));
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
    quiet.value = { enabled: false, start: 0, end: 0 };
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(props({ companion: { ...companion, state: 'sleeping' }, needsYou: [waitingItem('p1', 12)] }));
    expect(host.querySelector('[data-testid="speak-bubble"]')).toBeNull();
  });

  it('offers itself once, with one quiet line, and never again after an answer', async () => {
    await render(props());
    expect(host.querySelector('[data-testid="speak-offer"]')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(OFFER_DELAY_MS + 10));
    expect(host.querySelector('[data-testid="speak-offer"]')?.textContent).toContain('Want Mochi to speak up');
    await act(async () => button('No thanks').click());
    expect(getSpeak()).toEqual({ ...SPEAK_DEFAULTS, offered: true });
    expect(host.querySelector('[data-testid="speak-offer"]')).toBeNull();
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(host.querySelector('[data-testid="speak-offer"]')).toBeNull();
  });

  it('Yes turns it on', async () => {
    await render(props());
    await act(async () => void vi.advanceTimersByTime(OFFER_DELAY_MS + 10));
    await act(async () => button('Yes, a little').click());
    expect(getSpeak().on).toBe(true);
  });
});

const turns = [{ id: 't1', user: { text: 'fix the login' }, steps: [] }] as unknown as ChatTurn[];

function fakeApi(answer = 'It is fixing the login page.\nIt needs nothing from you.') {
  const ask = vi.fn(async () => ({ ok: true, answer }));
  const api = { target: vi.fn(async () => ({ agent: 'claude', label: 'Claude' })), ask } as unknown as SideQuestionApi;
  return { api, ask };
}

async function dropPotatoOn(y: number) {
  await fire(host.querySelector('.ck-companion-face')!, 'pointerdown', 10, 10);
  await fire(window, 'pointermove', 100, y);
  await fire(window, 'pointermove', 100, y + 1);
  await fire(window, 'pointerup', 100, y + 1);
}

describe('drop Potato on an agent', () => {
  beforeEach(() => {
    localStorage.setItem(SPEAK_KEY, JSON.stringify({ on: false, perHour: 3, offered: true }));
    reloadSpeakForTests();
  });

  it('shows the plan note first, then two lines and the three choices; Nudge writes only after its click', async () => {
    offs.push(registerPaneTurns('p1', () => turns));
    const { api, ask } = fakeApi();
    const p = props({ api });
    await render(p);
    await dropPotatoOn(110);
    expect(host.querySelector('[data-potato-target]')).toBeNull(); // the outline goes when the drag ends
    expect(text()).toContain("A check uses a little of this agent's plan.");
    expect(ask).not.toHaveBeenCalled();
    await act(async () => button('Check').click());
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    const [paneId, request] = ask.mock.calls[0] as unknown as [string, { question: string; context: string }];
    expect(paneId).toBe('p1');
    expect(request.context).toContain('Person: fix the login');
    expect(text()).toContain('It is fixing the login page.');
    expect(text()).toContain('It needs nothing from you.');
    expect(text()).toContain('Nudge sends: "status?"');
    expect([...host.querySelectorAll('[data-testid="potato-check"] button')].map((b) => b.textContent)).toEqual(['Watch it for me', 'Nudge it', 'Thanks']);
    expect(p.onNudge).not.toHaveBeenCalled();
    await act(async () => button('Nudge it').click());
    expect(p.onNudge).toHaveBeenCalledWith('p1');
    expect(text()).toContain('Sent.');
  });

  it('says the note only once', async () => {
    localStorage.setItem(NOTED_KEY, '1');
    offs.push(registerPaneTurns('p1', () => turns));
    const { api, ask } = fakeApi();
    await render(props({ api }));
    await dropPotatoOn(110);
    await settle();
    expect(text()).not.toContain('uses a little');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('a terminal agent with no chat is summarised from its activity, and says so, without asking', async () => {
    const { api, ask } = fakeApi();
    await render(props({ api }));
    await dropPotatoOn(150);
    await settle();
    expect(ask).not.toHaveBeenCalled();
    expect(text()).toContain('It is working: Editing app.ts.');
    expect(text()).toContain('Codex has no chat to read, so this comes from what it shows on screen.');
    expect(text()).not.toContain('uses a little');
  });

  it('Watch it for me tells the person once when the agent changes', async () => {
    localStorage.setItem(NOTED_KEY, '1');
    offs.push(registerPaneTurns('p1', () => turns));
    const { api } = fakeApi();
    const p = props({ api });
    await render(p);
    await dropPotatoOn(110);
    await settle();
    await act(async () => button('Watch it for me').click());
    expect(text()).toContain('I will tell you when Claude 2 changes.');
    await act(async () => button('Thanks').click());
    await rerender({ ...p, panes: [{ id: 'p1', status: 'idle' }, { id: 'p2', status: 'running' }] });
    expect(host.querySelector('[data-testid="watch-bubble"]')?.textContent).toContain('Claude 2 is calm now.');
    await act(async () => button('Thanks').click());
    await rerender({ ...p, panes: [{ id: 'p1', status: 'running' }, { id: 'p2', status: 'running' }] });
    expect(host.querySelector('[data-testid="watch-bubble"]')).toBeNull();
  });

  it('works from the keyboard: the row menu asks for a check', async () => {
    const { requestPotatoCheck } = await import('../../../lib/potatoCheck');
    localStorage.setItem(NOTED_KEY, '1');
    const { api, ask } = fakeApi();
    offs.push(registerPaneTurns('p1', () => turns));
    await render(props({ api }));
    await act(async () => requestPotatoCheck('p1'));
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('[data-testid="potato-check"]')).toBeNull();
  });

  it('says plainly when it could not check', async () => {
    localStorage.setItem(NOTED_KEY, '1');
    offs.push(registerPaneTurns('p1', () => turns));
    const api = { target: vi.fn(async () => null), ask: vi.fn() } as unknown as SideQuestionApi;
    await render(props({ api }));
    await dropPotatoOn(110);
    await settle();
    expect(text()).toContain('I could not check Claude 2 just now.');
  });
});

describe('in Traditional Chinese', () => {
  it('the speak bubble and the check bubble have no English left over', async () => {
    useChinese();
    setSpeakSaved({ on: true, perHour: 3, offered: true });
    offs.push(registerPaneTurns('p1', () => turns));
    await render(props({ needsYou: [waitingItem('p1', 12)], api: fakeApi('正在修登入頁。' + String.fromCharCode(10) + '不需要你。').api }));
    const bubble = host.querySelector('[data-testid="speak-bubble"]')!;
    expect(bubble.textContent).toContain('12 分鐘');
    expect(visibleEnglish(bubble, ['Claude'])).toEqual([]);
    await act(async () => button('晚點').click());
    const { requestPotatoCheck } = await import('../../../lib/potatoCheck');
    await act(async () => requestPotatoCheck('p1'));
    expect(visibleEnglish(host.querySelector('[data-testid="potato-check"]')!, ['Claude', 'status'])).toEqual([]);
  });
});
