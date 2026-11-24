// @vitest-environment jsdom
// P4.5: what another PC waits on (a question or an approval) shows in THIS PC's Inbox, in the sidebar count and on the Doto counter, as
// the same card a local question is; answering here settles it there; a card the far PC drops leaves here; a PC that lets this one
// only watch shows none. Rendered through the real Inbox and Sidebar, fed by the real device groups hook (as CockpitApp wires it).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC } from '../../dev/devices-fixtures';
import type { CockpitApi } from '../../hooks/useCockpit';
import { FarNeedsContext, NeedsYouContext, useNeedsYouSource, type FarNeeds } from '../../hooks/useNeedsYou';
import type { AskbarApi } from '../../lib/askbar';
import { useDeviceGroups } from '../devices/useDeviceGroups';
import { Inbox } from './Inbox';
import { Sidebar } from './Sidebar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined, emit: async () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.setItem('pm.sidebar.groupBy', 'status');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const askbar = { notices: async () => [], onNotice: async () => () => undefined, onNoticeRemoved: async () => () => undefined } as unknown as AskbarApi;

const LOCAL = { info: { id: 'here', agent_type: 'claude', pid: 1, status: 'idle', created_at: 1, last_output_at: null, cwd: 'C:\work\proj', cols: 80, rows: 24, title: null }, status: 'idle' };

function fakeApi(notify = vi.fn()): CockpitApi {
  return {
    // One chat of this PC is open, so the Inbox is not the first-run welcome.
    registry: { paneList: [LOCAL], panes: new Map([['here', LOCAL]]), initialReady: true },
    names: new Map(),
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: Date.now(),
    spawn: null,
    toasts: [],
    notify,
    bridgeLine: '',
    interrupt: vi.fn(),
  } as unknown as CockpitApi;
}

/** CockpitApp's wiring: the device groups feed the needs-you list and the far cards; the Inbox and the sidebar read them. */
function Screen({ fake, c }: { fake: DevicesFake; c: CockpitApi }) {
  const groups = useDeviceGroups(fake);
  const needs = useNeedsYouSource(c, {}, askbar, undefined, undefined, undefined, undefined, groups.questions);
  const far: FarNeeds = { questions: groups.questions, chatQuestions: groups.allQuestions, open: (key) => (opened.push(key), true), answer: groups.answerQuestion, hide: groups.hideQuestion };
  return (
    <NeedsYouContext.Provider value={needs}>
      <FarNeedsContext.Provider value={far}>
        <Sidebar c={c} onOpenPalette={() => {}} />
        <Inbox c={c} />
      </FarNeedsContext.Provider>
    </NeedsYouContext.Provider>
  );
}

const opened: string[] = [];
const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await act(async () => {});
};
const APPROVAL = { id: 'q-1', question: 'Run npm test?', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }], allow_free_text: false, pane_id: 'p1' };

async function mount(level: 'watch' | 'answer' | 'full', questions = [APPROVAL], c = fakeApi()) {
  const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, level }], panes: { [NODE_MAC]: [] } });
  fake.farLevels[NODE_MAC] = level;
  fake.questionsOf[NODE_MAC] = questions.map((q) => ({ ...q }));
  await act(async () => root.render(<Screen fake={fake} c={c} />));
  await flush();
  return { fake, c };
}
const cards = () => [...host.querySelectorAll<HTMLElement>('[data-question-id]')];
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[data-question-id] button')].find((b) => b.textContent === label);

describe('another PC waits on you: it shows here', () => {
  it('a far approval is a card in the Inbox with the one where line, and counts on the Doto counter and the sidebar', async () => {
    await mount('answer');
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.getAttribute('data-question-id')).toBe(`dev:${NODE_MAC}:q-1`);
    expect(cards()[0]!.textContent).toContain('Run npm test?');
    expect(cards()[0]!.textContent).toContain('On Mac mini');
    expect(host.querySelector('.ck-inbox-count')!.textContent).toBe('1');
    expect(host.querySelector('.ck-row--flat .ck-count')!.textContent).toBe('1');
  });

  it('answering here sends the choice to that PC by its own id, and the card is gone here and there', async () => {
    const { fake } = await mount('answer');
    await act(async () => button('Deny')!.click());
    await flush();
    expect(fake.answeredQuestions).toEqual([{ node: NODE_MAC, id: 'q-1', answer: { choice_id: 'deny' } }]);
    expect(fake.questionsOf[NODE_MAC]).toEqual([]);
    expect(cards()).toHaveLength(0);
    expect(host.querySelector('.ck-inbox-count')?.textContent ?? '0').toBe('0');
  });

  it('a card the far PC settles on its own screen leaves here when it says its questions changed', async () => {
    const { fake } = await mount('full');
    expect(cards()).toHaveLength(1);
    fake.questionsOf[NODE_MAC] = [];
    await act(async () => fake.emitQuestions(NODE_MAC));
    await flush();
    expect(cards()).toHaveLength(0);
    // And a new one rings here.
    fake.questionsOf[NODE_MAC] = [{ ...APPROVAL, id: 'q-2', question: 'Delete the build folder?' }];
    await act(async () => fake.emitQuestions(NODE_MAC));
    await flush();
    expect(cards().map((c) => c.getAttribute('data-question-id'))).toEqual([`dev:${NODE_MAC}:q-2`]);
  });

  it('a refused answer says why in the usual toast and the card stays', async () => {
    const c = fakeApi();
    const { fake } = await mount('answer', [APPROVAL], c);
    fake.farLevels[NODE_MAC] = 'watch';
    await act(async () => button('Allow')!.click());
    await flush();
    expect(c.notify).toHaveBeenCalled();
    expect(fake.answeredQuestions).toEqual([]);
    expect(cards()).toHaveLength(1);
  });

  it('Open chat opens the far chat the card belongs to; Dismiss leaves the card in its chat and the count agrees', async () => {
    opened.length = 0;
    const { fake } = await mount('answer');
    const openBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-question-id] button')].find((b) => /open/i.test(b.textContent ?? ''))!;
    await act(async () => openBtn.click());
    expect(opened).toEqual([`dev:${NODE_MAC}:p1`]);
    const dismiss = [...host.querySelectorAll<HTMLButtonElement>('[data-question-id] button')].find((b) => /dismiss/i.test(b.textContent ?? ''))!;
    await act(async () => dismiss.click());
    await flush();
    expect(cards()).toHaveLength(0);
    expect(host.querySelector('.ck-inbox-count')?.textContent ?? '0').toBe('0');
    // The far agent still waits: nothing was answered, and the card is still there for its chat.
    expect(fake.answeredQuestions).toEqual([]);
  });

  it('a PC that lets this one only watch puts nothing in the Inbox', async () => {
    await mount('watch');
    expect(cards()).toHaveLength(0);
    expect(host.querySelector('.ck-inbox-count')?.textContent ?? '0').toBe('0');
  });

  it('far text is drawn as text: markup stays text, control characters are gone, and a flood is cut', async () => {
    const nasty = { ...APPROVAL, question: '<img src=x onerror=alert(1)>‮real\u0000 question', choices: [{ id: 'a', label: '<b>Yes</b>' }, ...Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, label: `Choice ${i}` }))] };
    const many = Array.from({ length: 50 }, (_, i) => ({ ...APPROVAL, id: `m${i}`, question: `Question ${i}` }));
    await mount('answer', [nasty, ...many]);
    expect(host.querySelector('[data-question-id] img')).toBeNull();
    const first = cards().find((card) => card.getAttribute('data-question-id') === `dev:${NODE_MAC}:q-1`)!;
    expect(first.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(first.textContent).not.toContain('‮');
    expect(cards()).toHaveLength(30);
    expect(first.querySelectorAll('.ck-btn').length).toBeLessThan(20);
  });

  it('this PC does not ask a PC that is away, and shows none of its cards', async () => {
    const fake = new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, state: 'offline', level: 'full' }], panes: { [NODE_MAC]: [] } });
    fake.questionsOf[NODE_MAC] = [APPROVAL];
    const asked = vi.spyOn(fake, 'request');
    await act(async () => root.render(<Screen fake={fake} c={fakeApi()} />));
    await flush();
    expect(cards()).toHaveLength(0);
    expect(asked.mock.calls.some((call) => String(call[2] ?? '').includes('/pclink/questions'))).toBe(false);
  });
});
