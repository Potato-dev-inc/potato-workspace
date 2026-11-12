// @vitest-environment jsdom
// "Bring my chats" panel: a fake api with a small in-memory store, fake progress events, no agent folder touched.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatImport from '../../lib/chatImport';
import type { BrowseRow, ImportApi, ImportFound, ImportProgress, ImportState } from '../../lib/chatImport';
import * as chatIndex from '../../lib/chatIndex';
import { BringChatsPanel, BRING_REMOVE_BODY } from './BringChatsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const DAY = 86_400_000;

const found = (id: string, label: string, chats: number): ImportFound => ({
  id,
  label,
  fromDefinition: false,
  chats,
  bytes: 1024,
  oldestMs: NOW - 400 * DAY,
  newestMs: NOW - 2 * DAY,
  already: 0,
  tooBig: 0,
  places: [`~/.${id}/sessions`],
  canContinue: true,
});

const IDLE = chatImport.idleProgress();

/** 25 chats for the agent "alpha", newest first: chat 1 is 1 day old, chat 2 is 2 days old, and so on up to 25 days. */
function chatsOf(count: number): BrowseRow[] {
  return Array.from({ length: count }, (_, i) => ({
    session: `session-${String(i + 1).padStart(3, '0')}`,
    title: `Chat number ${i + 1}`,
    folder: i % 2 === 0 ? 'shop' : 'notes',
    updatedMs: NOW - (i + 1) * DAY,
    messages: 10 + i,
    messagesCut: false,
    brought: false,
    bytes: 100,
    error: null,
  }));
}

function state(over: Partial<ImportState> = {}): ImportState {
  return {
    asked: true,
    sinceDays: null,
    indexEnabled: true,
    agents: [
      { id: 'alpha', label: 'Alpha', fromDefinition: false, enabled: true },
      { id: 'beta', label: 'Beta', fromDefinition: false, enabled: true },
      { id: 'gamma', label: 'Gamma', fromDefinition: false, enabled: true },
      { id: 'delta', label: 'Delta', fromDefinition: false, enabled: true },
    ],
    progress: IDLE,
    imported: { chats: 0, items: 0 },
    ...over,
  };
}

/** The fake store: alpha has 25 chats, beta 3, gamma none; delta has no reader. `brought` remembers what a run wrote. */
function fakeApi(chats = chatsOf(25)) {
  const brought = new Set<string>();
  let progress: ImportProgress = IDLE;
  const api: ImportApi & { brought: Set<string> } = {
    brought,
    state: vi.fn(async () => state({ progress })),
    look: vi.fn(async () => [found('alpha', 'Alpha', chats.length), found('beta', 'Beta', 3), found('gamma', 'Gamma', 0)]),
    browse: vi.fn(async (agent, range, offset, limit) => {
      const all = (agent === 'alpha' ? chats : chatsOf(3))
        .filter((c) => (range.fromMs === null || c.updatedMs >= range.fromMs) && (range.toMs === null || c.updatedMs <= range.toMs))
        .map((c) => ({ ...c, brought: brought.has(`${agent}:${c.session}`) }));
      const rows = all.slice(offset, offset + limit);
      return { rows, total: all.length, offset, next: offset + rows.length, more: offset + limit < all.length, tooBig: 0, unreadable: 0 };
    }),
    bring: vi.fn(async (request) => {
      const all = (request.agent === 'alpha' ? chats : chatsOf(3)).filter(
        (c) =>
          (request.sessions === null || request.sessions.includes(c.session)) &&
          (request.fromMs === null || c.updatedMs >= request.fromMs) &&
          (request.toMs === null || c.updatedMs <= request.toMs),
      );
      // A chat brought before and unchanged is skipped, like the importer does: never twice.
      let fresh = 0;
      let again = 0;
      for (const c of all) {
        if (brought.has(`${request.agent}:${c.session}`)) again += 1;
        else {
          brought.add(`${request.agent}:${c.session}`);
          fresh += 1;
        }
      }
      progress = { ...IDLE, phase: 'done' as const, chatsTotal: all.length, chatsDone: all.length, brought: fresh, unchanged: again };
      return { ...IDLE, phase: 'reading' as const, chatsTotal: all.length };
    }),
    start: vi.fn(),
    cancel: vi.fn(async () => ({ ...IDLE, phase: 'cancelled' as const })),
    dismiss: vi.fn(async () => undefined),
    clear: vi.fn(async () => ({ enabled: true, items: 0, bytes: 0, importedChats: 0, importedItems: 0 })),
    open: vi.fn(),
    resumePlan: vi.fn(),
  };
  return api;
}

let progressCallback: ((p: ImportProgress) => void) | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  progressCallback = null;
  vi.spyOn(chatImport, 'onImportProgress').mockImplementation((cb) => {
    progressCallback = cb;
    return () => {};
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
};

async function render(api: ImportApi) {
  await act(async () => {
    root.render(<BringChatsPanel api={api} now={() => NOW} />);
  });
  await settle();
}

async function click(element: Element | null | undefined) {
  await act(async () => {
    (element as HTMLElement | null)?.click();
  });
  await settle();
}

const text = () => host.textContent ?? '';
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const agentButton = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('.bc-agent-pick')].find((b) => b.textContent?.includes(name));
const rowTitles = () => [...host.querySelectorAll('.bc-row-title')].map((e) => e.textContent);
const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('.bc-row input[type="checkbox"]')];

describe('BringChatsPanel: the agents', () => {
  it('lists the agents with a count each; an agent with none says so; an agent with no reader is greyed', async () => {
    const api = fakeApi();
    await render(api);
    expect(text()).toContain('Alpha · 25 chats');
    expect(text()).toContain('Beta · 3 chats');
    expect(text()).toContain('Gamma');
    expect(text()).toContain('No chats found on this PC');
    expect(agentButton('Gamma')!.disabled).toBe(true);
    expect(text()).toContain("Delta");
    expect(text()).toContain("This agent's chats can't be read yet");
    // A plain reason, no folder paths (the folders are never shown to the person).
    expect(text()).toContain('No chats found on this PC');
    expect(text()).not.toMatch(/~\/|\.local|\/sessions/);
    expect(api.look).toHaveBeenCalledTimes(1);
    expect(api.browse).not.toHaveBeenCalled();
  });

  it('reads nothing when chat search is off: it offers to turn it on', async () => {
    const api = fakeApi();
    (api.state as ReturnType<typeof vi.fn>).mockResolvedValue(state({ indexEnabled: false }));
    const turnOn = vi.spyOn(chatIndex, 'chatIndexSetEnabled').mockResolvedValue({ enabled: true, items: 0, bytes: 0, oldCopies: 0 });
    await render(api);
    expect(text()).toContain('Chat search is off');
    expect(api.look).not.toHaveBeenCalled();
    await click(button('Turn on'));
    expect(turnOn).toHaveBeenCalledWith(true);
    expect(api.look).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Alpha · 25 chats');
  });
});

describe('BringChatsPanel: the 10 newest chats', () => {
  it('shows ten rows with title, folder, date and message count, and Show more adds ten', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    expect(api.browse).toHaveBeenCalledWith('alpha', { fromMs: null, toMs: null }, 0, 10);
    expect(rowTitles()).toHaveLength(10);
    expect(rowTitles()[0]).toBe('Chat number 1');
    const first = host.querySelector('.bc-row')!.textContent!;
    expect(first).toContain('shop');
    expect(first).toContain('1 day ago');
    expect(first).toContain('10 messages');
    expect(host.querySelectorAll('.bc-row')[1].textContent).toContain('2 days ago');

    await click(button('Show more'));
    expect(api.browse).toHaveBeenLastCalledWith('alpha', { fromMs: null, toMs: null }, 10, 10);
    expect(rowTitles()).toHaveLength(20);
    await click(button('Show more'));
    expect(rowTitles()).toHaveLength(25);
    expect(button('Show more')).toBeUndefined();
  });

  it('Bring these is off until a chat is ticked, then brings exactly the ticked ones', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    expect(button('Bring these')!.disabled).toBe(true);
    await click(checkboxes()[0]);
    await click(checkboxes()[2]);
    expect(button('Bring these (2)')!.disabled).toBe(false);
    await click(button('Bring these (2)'));
    expect(api.bring).toHaveBeenCalledWith({ agent: 'alpha', sessions: ['session-001', 'session-003'], fromMs: null, toMs: null });
  });
});

describe('BringChatsPanel: time ranges', () => {
  it('a chip filters the list and offers to bring all of the range, with a count and a short sample', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    await click(button('Last 7 days'));
    expect(api.browse).toHaveBeenLastCalledWith('alpha', { fromMs: NOW - 7 * DAY, toMs: null }, 0, 10);
    expect(rowTitles()).toHaveLength(7);
    expect(button('Last 7 days')!.getAttribute('aria-pressed')).toBe('true');
    const bringAll = button('Bring all 7 chats from this range')!;
    expect(bringAll).toBeDefined();
    expect([...host.querySelectorAll('.bc-range li')].map((li) => li.textContent)).toEqual(['Chat number 1', 'Chat number 2', 'Chat number 3']);
    await click(bringAll);
    expect(api.bring).toHaveBeenCalledWith({ agent: 'alpha', sessions: null, fromMs: NOW - 7 * DAY, toMs: null });
  });

  it('has the chips Last 7 days, Last 30 days, Last 3 months, All and Custom, and a second press clears one', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    expect([...host.querySelectorAll('.bc-chip')].map((b) => b.textContent)).toEqual(['Last 7 days', 'Last 30 days', 'Last 3 months', 'All', 'Custom…']);
    await click(button('Last 30 days'));
    expect(button('Bring all 25 chats from this range')).toBeDefined();
    await click(button('All'));
    expect(button('Bring all 25 chats')).toBeDefined();
    await click(button('All'));
    expect(button('Bring all 25 chats')).toBeUndefined();
    expect(rowTitles()).toHaveLength(10);
  });

  it('Custom asks for two dates and filters by them (local days, both ends included)', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    await click(button('Custom…'));
    expect(host.querySelector('input[aria-label="From date"]')).not.toBeNull();
    const set = async (label: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await settle();
    };
    await set('From date', '2026-10-25');
    await set('To date', '2026-11-05');
    const last = (api.browse as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(last[0]).toBe('alpha');
    expect(last[1].fromMs).toBe(new Date(2026, 9, 25).getTime());
    expect(last[1].toMs).toBe(new Date(2026, 10, 6).getTime() - 1);
    expect([...host.querySelectorAll('button')].some((b) => /^Bring all \d+ chats from this range$/.test(b.textContent ?? ''))).toBe(true);
  });

  it('shows "No chats in this range" and no bring-all button when the range is empty', async () => {
    const api = fakeApi(chatsOf(2).map((c) => ({ ...c, updatedMs: NOW - 200 * DAY })));
    await render(api);
    await click(agentButton('Alpha'));
    await click(button('Last 7 days'));
    expect(text()).toContain('No chats in this range.');
    expect(host.querySelector('.bc-range')).toBeNull();
  });
});

describe('BringChatsPanel: bringing', () => {
  it('shows "Bringing 37 chats… 12 done" while it works, then the done line with Why? for the ones that failed', async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    await click(checkboxes()[0]);
    await click(button('Bring these (1)'));
    // The run is under way: the events carry its progress.
    await act(async () => progressCallback?.({ ...IDLE, phase: 'reading', chatsTotal: 37, chatsDone: 12 }));
    expect(text()).toContain('Bringing 37 chats… 12 done');
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('12');
    expect(button('Stop')).toBeDefined();
    // The end comes through the event too.
    await act(async () =>
      progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 39, chatsDone: 39, brought: 37, unreadable: 2, missing: 1, format: 1 }),
    );
    await settle();
    expect(text()).toContain('Done. 37 chats are now in your chat list. 2 could not be read');
    const why = host.querySelector('details.bc-why')!;
    expect(why.querySelector('summary')!.textContent).toBe('Why?');
    expect(why.textContent).toContain('moved or deleted');
    expect(why.textContent).toContain('format this version does not know');
  });

  it('with nothing failed there is no Why? fold', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Beta'));
    await click(button('All'));
    await click(button('Bring all 3 chats'));
    await act(async () => progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 3, chatsDone: 3, brought: 3 }));
    await settle();
    expect(text()).toContain('Done. 3 chats are now in your chat list.');
    expect(host.querySelector('details.bc-why')).toBeNull();
  });

  it('re-running the same chats does not add them twice: the second run reports them as already there', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Beta'));
    await click(button('All'));
    await click(button('Bring all 3 chats'));
    await act(async () => progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 3, chatsDone: 3, brought: 3 }));
    await settle();
    expect(api.brought.size).toBe(3);

    await click(button('Bring more'));
    // The rows know which chats are brought.
    expect(text()).toContain('Already brought');
    // The All chip is still on from the first run.
    await click(button('Bring all 3 chats'));
    expect(api.brought.size).toBe(3);
    await act(async () => progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 3, chatsDone: 3, brought: 0, unchanged: 3 }));
    await settle();
    expect(text()).toContain('Done. 3 chats are now in your chat list.');
    expect(text()).toContain('3 chats were already in your chat list.');
  });

  it('Stop asks the importer to stop', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Alpha'));
    await click(checkboxes()[0]);
    await click(button('Bring these (1)'));
    await act(async () => progressCallback?.({ ...IDLE, phase: 'reading', chatsTotal: 5, chatsDone: 1 }));
    await click(button('Stop'));
    expect(api.cancel).toHaveBeenCalledTimes(1);
  });

  it('Remove imported chats asks first and then clears', async () => {
    const api = fakeApi();
    await render(api);
    await click(agentButton('Beta'));
    await click(button('All'));
    await click(button('Bring all 3 chats'));
    await act(async () => progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 3, chatsDone: 3, brought: 3 }));
    await settle();
    await click(button('Remove imported chats'));
    expect(text()).toContain(BRING_REMOVE_BODY);
    expect(api.clear).not.toHaveBeenCalled();
    await click(button('Remove'));
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(text()).toContain('Brought chats removed');
  });

  it('shows an error from the api in a status line', async () => {
    const api = fakeApi();
    (api.browse as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('The store is busy.'));
    await render(api);
    await click(agentButton('Alpha'));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('The store is busy.');
  });
});
