// "Bring my chats" for the harness: what the mocked `chat_import_*` commands answer. Example data only (made-up chats
// of made-up agents); no agent folder is read. The store lives for the page, so Bring and "Show more" work.
import type { BrowseRow, ImportFound, ImportProgress } from '../lib/chatImport';

export interface BringChatsScenario {
  /** How the run goes after "Bring": `done` (default), `failed-some` (two chats could not be read). */
  outcome?: 'done' | 'failed-some';
}

const DAY = 86_400_000;
const FOLDERS = ['potato-workspace', 'potato-site', 'shop-api', 'notes'];
const TITLES = [
  'Fix the login redirect after sign-in',
  'Why is the docs build so slow?',
  'Add a dark mode switch to Settings',
  'Write a script that renames the photos',
  'Explain this stack trace',
  'Set up the nightly backup job',
  'Turn the CSV into a chart',
  'Review my cover letter',
  'Make the invoice table sortable',
  'Plan the trip to Tainan',
  'Translate the README to Spanish',
  'Why does the test only fail on CI?',
];

function chatsOf(agent: string, count: number): BrowseRow[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    session: `${agent}-session-${String(i + 1).padStart(4, '0')}`,
    title: TITLES[i % TITLES.length],
    folder: FOLDERS[i % FOLDERS.length],
    updatedMs: now - (i * 2 + 1) * DAY - 3_600_000,
    messages: 6 + ((i * 7) % 40),
    messagesCut: false,
    brought: false,
    bytes: 4096,
    error: null,
  }));
}

const found = (id: string, label: string, chats: number, places: string[], newestDays: number | null): ImportFound => ({
  id,
  label,
  fromDefinition: false,
  chats,
  bytes: chats * 40_000,
  oldestMs: null,
  newestMs: newestDays === null ? null : Date.now() - newestDays * DAY,
  already: 0,
  tooBig: 0,
  places,
  canContinue: true,
});

const FOUND: ImportFound[] = [
  found('claude', 'Claude', 212, ['~/.claude/projects'], 1),
  found('codex', 'Codex', 84, ['~/.codex/sessions'], 3),
  found('opencode', 'OpenCode', 0, ['~/.local/share/opencode'], null),
];

const IDLE: ImportProgress = {
  phase: 'idle',
  agent: null,
  chatsDone: 0,
  chatsTotal: 0,
  items: 0,
  unchanged: 0,
  tooBig: 0,
  unreadable: 0,
  missing: 0,
  format: 0,
  brought: 0,
  empty: 0,
  message: null,
};

export interface BringChatsState {
  brought: Set<string>;
  progress: ImportProgress;
}

export function newBringChatsState(): BringChatsState {
  return { brought: new Set(), progress: IDLE };
}

/** `handled: false` leaves the command to the normal mock. */
export function bringChatsMock(
  s: BringChatsScenario | undefined,
  state: BringChatsState,
  cmd: string,
  a: Record<string, unknown>,
): { handled: boolean; value?: unknown } {
  if (!s || !cmd.startsWith('chat_import_')) return { handled: false };
  switch (cmd) {
    case 'chat_import_state':
      return {
        handled: true,
        value: {
          asked: true,
          sinceDays: null,
          indexEnabled: true,
          agents: [...FOUND.map((f) => ({ id: f.id, label: f.label })), { id: 'cursor_agent', label: 'Cursor Agent' }].map((x) => ({ ...x, fromDefinition: false, enabled: true })),
          progress: state.progress,
          imported: { chats: state.brought.size, items: state.brought.size * 5 },
        },
      };
    case 'chat_import_look':
      return { handled: true, value: { found: FOUND } };
    case 'chat_import_browse': {
      const agent = String(a.agent);
      const total = FOUND.find((f) => f.id === agent)?.chats ?? 0;
      const all = chatsOf(agent, Math.min(total, 60))
        .filter((c) => (a.fromMs == null || c.updatedMs >= Number(a.fromMs)) && (a.toMs == null || c.updatedMs <= Number(a.toMs)))
        .map((c) => ({ ...c, brought: state.brought.has(c.session) }));
      const offset = Number(a.offset ?? 0);
      const limit = Number(a.limit ?? 10);
      const rows = all.slice(offset, offset + limit);
      return { handled: true, value: { rows, total: all.length, offset, next: offset + rows.length, more: offset + limit < all.length, tooBig: 0, unreadable: 0 } };
    }
    case 'chat_import_start': {
      const sessions = (a.sessions as string[] | null) ?? null;
      const fresh = sessions ?? chatsOf(String((a.agents as string[])[0]), 7).map((c) => c.session);
      fresh.forEach((id) => state.brought.add(id));
      const failed = s.outcome === 'failed-some';
      const total = fresh.length + (failed ? 2 : 0);
      state.progress = { ...IDLE, phase: 'done', chatsTotal: total, chatsDone: total, brought: fresh.length, unreadable: failed ? 2 : 0, missing: failed ? 1 : 0, format: failed ? 1 : 0 };
      return { handled: true, value: { ...IDLE, phase: 'reading', chatsTotal: total } };
    }
    case 'chat_import_cancel':
      return { handled: true, value: IDLE };
    case 'chat_import_clear':
      state.brought.clear();
      state.progress = IDLE;
      return { handled: true, value: { enabled: true, items: 0, bytes: 0, oldCopies: 0, importedChats: 0, importedItems: 0 } };
    default:
      return { handled: false };
  }
}
