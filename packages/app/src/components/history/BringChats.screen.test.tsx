// @vitest-environment jsdom
// "Bring my chats", screen level. The entry points people look in (the empty chat list, the New agent page, Settings >
// Agents, Settings > General and the palette) each open the same sheet; inside it the whole flow runs against a fake api
// with a small in-memory store: the agents with a count each, an agent's 10 newest chats, a time range, bringing, the
// result, and bringing again without a duplicate. No agent folder is touched.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import * as chatImport from '../../lib/chatImport';
import type { BrowseRow, ImportApi, ImportFound, ImportProgress } from '../../lib/chatImport';
import type { ShipApi } from '../../lib/ship-api';
import { Sidebar } from '../cockpit/Sidebar';
import { agentsRows } from '../settings/sections/AgentsSection';
import { BringChatsSettings } from '../settings/blocks/BringChatsSettings';
import type { SettingsEnv } from '../settings/model';
import { BringChatsHost } from './ImportHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const DAY = 86_400_000;
const IDLE = chatImport.idleProgress();

const found = (id: string, label: string, chats: number): ImportFound => ({
  id,
  label,
  fromDefinition: false,
  chats,
  bytes: 4096,
  oldestMs: Date.now() - 300 * DAY,
  newestMs: Date.now() - DAY,
  already: 0,
  tooBig: 0,
  places: [`~/.${id}`],
  canContinue: true,
});

/** 23 chats for "alpha": chat n is n days and an hour old (so "Last 7 days" holds chats 1 to 6). */
const ALPHA: BrowseRow[] = Array.from({ length: 23 }, (_, i) => ({
  session: `alpha-${String(i + 1).padStart(3, '0')}`,
  title: `Alpha chat ${i + 1}`,
  folder: 'shop',
  updatedMs: Date.now() - (i + 1) * DAY - 3_600_000,
  messages: 4 + i,
  messagesCut: false,
  brought: false,
  bytes: 10,
  error: null,
}));

/** The importer in miniature: it keeps what was brought and never brings a chat twice. */
function fakeApi() {
  const store = new Set<string>();
  let progress: ImportProgress = IDLE;
  const api: ImportApi & { store: Set<string> } = {
    store,
    state: vi.fn(async () => ({
      asked: true,
      sinceDays: null,
      indexEnabled: true,
      agents: [
        { id: 'alpha', label: 'Alpha', fromDefinition: false, enabled: true },
        { id: 'beta', label: 'Beta', fromDefinition: false, enabled: true },
      ],
      progress,
      imported: { chats: store.size, items: store.size * 3 },
    })),
    look: vi.fn(async () => [found('alpha', 'Alpha', ALPHA.length), found('beta', 'Beta', 0)]),
    browse: vi.fn(async (_agent, range, offset, limit) => {
      const all = ALPHA.filter((c) => (range.fromMs === null || c.updatedMs >= range.fromMs) && (range.toMs === null || c.updatedMs <= range.toMs)).map(
        (c) => ({ ...c, brought: store.has(c.session) }),
      );
      const rows = all.slice(offset, offset + limit);
      return { rows, total: all.length, offset, next: offset + rows.length, more: offset + limit < all.length, tooBig: 0, unreadable: 0 };
    }),
    bring: vi.fn(async (request) => {
      const picked = ALPHA.filter(
        (c) =>
          (request.sessions === null || request.sessions.includes(c.session)) &&
          (request.fromMs === null || c.updatedMs >= request.fromMs) &&
          (request.toMs === null || c.updatedMs <= request.toMs),
      );
      const fresh = picked.filter((c) => !store.has(c.session));
      fresh.forEach((c) => store.add(c.session));
      progress = { ...IDLE, phase: 'done' as const, chatsTotal: picked.length, chatsDone: picked.length, brought: fresh.length, unchanged: picked.length - fresh.length };
      return { ...IDLE, phase: 'reading' as const, chatsTotal: picked.length };
    }),
    start: vi.fn(),
    cancel: vi.fn(async () => IDLE),
    dismiss: vi.fn(async () => undefined),
    clear: vi.fn(),
    open: vi.fn(),
    resumePlan: vi.fn(),
  };
  return { api, finish: () => progressCallback?.(progress) };
}

let progressCallback: ((p: ImportProgress) => void) | null = null;
let host: HTMLDivElement;
let root: Root;

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
  document.body.querySelectorAll('[role="dialog"]').forEach((e) => e.remove());
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => Promise.resolve());
};
const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const click = async (el: Element | null | undefined) => {
  expect(el, 'the element to click exists').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
};
const panelTitle = () => q('#bc-panel-title')?.textContent;
const rowTitles = () => [...document.querySelectorAll('.bc-row-title')].map((e) => e.textContent);

const emptyCockpit = () =>
  ({
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    launchEntries: [{ type: 'codex', label: 'Codex' }],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: {},
    statusSince: new Map(),
    now: 60_000,
    spawn: null,
    toasts: [],
    notify: vi.fn(),
    openSettings: vi.fn(async () => {}),
    bridgeLine: '',
  }) as unknown as CockpitApi;
const ship = { recent: vi.fn().mockResolvedValue([]), gitState: vi.fn().mockResolvedValue('repo') } as unknown as ShipApi;

const env = { settings: {}, patch: vi.fn(), markSaved: vi.fn(), setError: vi.fn(), confirm: vi.fn(), bridgeUrl: '' } as unknown as SettingsEnv;

describe('Bring my chats: the entry points', () => {
  it('the empty chat list offers it, and pressing it opens the panel, which lists the agents with a count each', async () => {
    const { api } = fakeApi();
    await act(async () =>
      root.render(
        <>
          <Sidebar c={emptyCockpit()} onOpenPalette={() => {}} ship={ship} />
          <BringChatsHost api={api} />
        </>,
      ),
    );
    await settle();
    expect(q('#bc-panel-title')).toBeNull();
    expect(host.textContent).toContain('No agents running.');
    await click(host.querySelector('[data-testid="bring-chats-link"]'));
    expect(panelTitle()).toBe('Bring my chats');
    expect(document.body.textContent).toContain('Alpha · 23 chats');
    expect(document.body.textContent).toContain('Beta · No chats found');
  });

  it('Settings > Agents has a "Bring my chats" row that opens the same panel', async () => {
    const { api } = fakeApi();
    const row = agentsRows.find((r) => r.id === 'bring-chats-agents')!;
    expect(row).toBeDefined();
    await act(async () =>
      root.render(
        <>
          {row.render(env)}
          <BringChatsHost api={api} />
        </>,
      ),
    );
    await click(button('Bring chats'));
    expect(panelTitle()).toBe('Bring my chats');
  });

  it('Settings > General keeps its "Bring my chats" row', async () => {
    const { api } = fakeApi();
    await act(async () =>
      root.render(
        <>
          <BringChatsSettings env={env} />
          <BringChatsHost api={api} />
        </>,
      ),
    );
    await settle();
    expect(host.textContent).toContain('Bring my chats');
    await click(button('Bring chats'));
    expect(panelTitle()).toBe('Bring my chats');
  });
});

describe('Bring my chats: agent, 10 newest, range, bring, bring again', () => {
  it('runs the whole flow and never brings a chat twice', async () => {
    const { api, finish } = fakeApi();
    await act(async () => root.render(<BringChatsHost api={api} />));
    chatImport.requestBringChats();
    await settle();

    // 1. The agents, with a count each; the one with none is greyed.
    expect(panelTitle()).toBe('Bring my chats');
    const beta = [...document.querySelectorAll<HTMLButtonElement>('.bc-agent-pick')].find((b) => b.textContent?.includes('Beta · No chats found'));
    expect(beta!.disabled).toBe(true);

    // 2. Pick an agent: its 10 newest chats, each with folder, date and message count.
    await click([...document.querySelectorAll<HTMLButtonElement>('.bc-agent-pick')].find((b) => b.textContent?.includes('Alpha')));
    expect(rowTitles()).toHaveLength(10);
    expect(rowTitles()[0]).toBe('Alpha chat 1');
    expect(q('.bc-row')!.textContent).toMatch(/shop · 1 day ago · 4 messages/);
    await click(button('Show more'));
    expect(rowTitles()).toHaveLength(20);

    // 3. A time range: Last 7 days -> "Bring all 6 chats from this range", with a short sample.
    await click(button('Last 7 days'));
    expect(rowTitles()).toHaveLength(6);
    expect(button('Bring all 6 chats from this range')).toBeTruthy();
    expect(q('.bc-range')!.textContent).toContain('Alpha chat 1');

    // 4. Bring it. The progress line, then the result.
    await click(button('Bring all 6 chats from this range'));
    act(() => progressCallback?.({ ...IDLE, phase: 'reading', chatsTotal: 6, chatsDone: 3 }));
    expect(document.body.textContent).toContain('Bringing 6 chats… 3 done');
    await act(async () => finish());
    await settle();
    expect(document.body.textContent).toContain('Done. 6 chats are now in your chat list.');
    expect(document.querySelector('details.bc-why')).toBeNull();
    expect(api.store.size).toBe(6);

    // 5. Bring more: the 6 show as brought; pick 2 that are already there plus 1 new one; only the new one is added.
    await click(button('Bring more'));
    await click(button('Last 7 days'));
    await click(button('Last 30 days'));
    expect(document.body.textContent).toContain('Already brought');
    const boxes = [...document.querySelectorAll<HTMLInputElement>('.bc-row input[type="checkbox"]')];
    await click(boxes[0]);
    await click(boxes[1]);
    await click(boxes[8]);
    await click(button('Bring these (3)'));
    await act(async () => finish());
    await settle();
    expect(api.store.size).toBe(7);
    expect(document.body.textContent).toContain('Done. 3 chats are now in your chat list.');
    expect(document.body.textContent).toContain('2 chats were already in your chat list.');

    // 6. Bringing the whole 30 days again adds only the rest, and the same range twice adds nothing.
    await click(button('Bring more'));
    await click(button('Bring all 23 chats from this range'));
    await act(async () => finish());
    await settle();
    expect(api.store.size).toBe(23);
    await click(button('Bring more'));
    await click(button('Bring all 23 chats from this range'));
    await act(async () => finish());
    await settle();
    expect(api.store.size).toBe(23);
    expect(document.body.textContent).toContain('Done. 23 chats are now in your chat list.');
    expect(document.body.textContent).toContain('23 chats were already in your chat list.');
  });

  it('says what went wrong with a "Why?" fold when some chats could not be read', async () => {
    const { api } = fakeApi();
    await act(async () => root.render(<BringChatsHost api={api} />));
    chatImport.requestBringChats();
    await settle();
    await click([...document.querySelectorAll<HTMLButtonElement>('.bc-agent-pick')].find((b) => b.textContent?.includes('Alpha')));
    await click(document.querySelector('.bc-row input[type="checkbox"]'));
    await click(button('Bring these (1)'));
    await act(async () => progressCallback?.({ ...IDLE, phase: 'done', chatsTotal: 39, chatsDone: 39, brought: 37, unreadable: 2, missing: 1, format: 1 }));
    await settle();
    expect(document.body.textContent).toContain('Done. 37 chats are now in your chat list. 2 could not be read');
    const why = document.querySelector('details.bc-why')!;
    expect(why.querySelector('summary')!.textContent).toBe('Why?');
    expect(why.textContent).toContain('moved or deleted');
  });
});
