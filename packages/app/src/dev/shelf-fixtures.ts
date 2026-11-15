// Example Team shelf data for the harness and the screen tests (dev only): skills and tools on this PC, two suggestions
// from teammates (one tool that needs the "I trust this" tick), one the team recommends, and a fake `ShelfApi`.
import type { CardView, MineView, Recommended, ShelfApi, ShelfApplied, ShelfPreview, ShelfRisk, ShelfState, ShelfTarget } from '../lib/shelf';

export const TARGETS: ShelfTarget[] = [
  { id: 'claude', label: 'Claude Code', installed: true, tools: true, skills: true },
  { id: 'codex', label: 'Codex', installed: true, tools: true, skills: true },
  { id: 'cursor_agent', label: 'Cursor', installed: false, tools: true, skills: false },
];

const mine = (over: Partial<MineView> & Pick<MineView, 'id' | 'kind' | 'name'>): MineView => ({
  about: '',
  source: 'local',
  agents: ['Claude Code'],
  shareable: true,
  reason: null,
  needs: [],
  shown: '',
  skippedFiles: 0,
  have: [],
  suggested: false,
  install: null,
  ...over,
});

export const MINE: MineView[] = [
  mine({ id: 'skill-review', kind: 'skill', name: 'Review checklist', have: ['Maya'], suggested: true }),
  mine({ id: 'tool-github', kind: 'tool', name: 'GitHub', agents: ['Claude Code', 'Codex'], needs: ['GITHUB_TOKEN'], shown: 'npx -y @modelcontextprotocol/server-github', have: ['Maya', 'Sam'] }),
  mine({ id: 'tool-postgres', kind: 'tool', name: 'Postgres', shareable: false, reason: 'The password is inside the command. Move it to a key first, then suggest it.' }),
  mine({
    id: 'local-tool-docs-1a2b3c4d',
    kind: 'tool',
    name: 'Docs',
    shareable: false,
    reason: 'It runs a program from a folder on your PC. A teammate does not have that file.',
    install: { id: 'aabbccddeeff001122334455', shown: 'npx -y @scope/docs-server' },
  }),
  mine({ id: 'local-tool-pencil-9f8e7d6c', kind: 'tool', name: 'pencil', shareable: false, reason: 'It runs a program from a folder on your PC. A teammate does not have that file.' }),
];

export const RISKY_LINE = 'npx -y @linear/mcp-server --workspace acme';

export const RISK_LINEAR: ShelfRisk = {
  shown: RISKY_LINE,
  needsTrust: true,
  reasons: ['It downloads and runs a package from the internet.', 'It uses a program name your PC does not know yet.'],
};

const card = (over: Partial<CardView> & Pick<CardView, 'cardId' | 'id' | 'kind' | 'name' | 'byName'>): CardView => ({
  about: '',
  by: 'm-maya',
  why: '',
  atMs: Date.now() - 3_600_000,
  everyone: false,
  needs: [],
  shown: '',
  risk: null,
  skippedFiles: 0,
  unknown: false,
  here: false,
  have: [],
  ...over,
});

export const SUGGESTED: CardView[] = [
  card({ cardId: 'c-notes', id: 'skill-notes', kind: 'skill', name: 'Release notes in simple English', byName: 'Maya', why: 'Short, clear release notes. Saves us an hour each week.', have: ['Maya'] }),
  card({ cardId: 'c-linear', id: 'tool-linear', kind: 'tool', name: 'Linear', byName: 'Sam', by: 'm-sam', why: 'Lets the agent read our tickets.', needs: ['LINEAR_API_KEY'], shown: RISKY_LINE, risk: RISK_LINEAR, have: ['Sam'] }),
  card({ cardId: 'c-future', id: 'x-future', kind: 'unknown', name: 'Routine from a newer build', byName: 'Maya', unknown: true }),
];

export const RECOMMENDED: Recommended[] = [
  { id: 'tool-browser', cardId: 'c-browser', kind: 'tool', name: 'Browser checks', about: '', byNames: ['Maya', 'Leo'], have: ['Maya', 'Leo', 'Sam'], here: false, unknown: false, needs: [], shown: 'npx -y browser-checks', risk: { shown: 'npx -y browser-checks', needsTrust: false, reasons: [] } },
  { id: 'skill-review', cardId: 'c-review', kind: 'skill', name: 'Review checklist', about: '', byNames: ['Maya'], have: ['Maya', 'Leo'], here: true, unknown: false, needs: [], shown: '', risk: null },
];

export const shelfState = (over: Partial<ShelfState> = {}): ShelfState => ({
  targets: TARGETS,
  mine: MINE,
  suggested: SUGGESTED,
  recommended: RECOMMENDED,
  people: [
    { id: 'm-maya', name: 'Maya' },
    { id: 'm-sam', name: 'Sam' },
  ],
  teamSize: 3,
  waiting: 2,
  ...over,
});

const SKILL_TEXT = '# Release notes in simple English\n\nWrite short notes. One line per change. No jargon.';
const TOOL_TEXT = '+ [mcp_servers.linear]\n+ command = "npx"\n+ args = ["-y", "@linear/mcp-server", "--workspace", "acme"]';

/** What Add would write for these agents (the fake backend's answer). */
export function previewFor(cardId: string, agents: string[], state: ShelfState = shelfState()): ShelfPreview {
  const all = [...state.suggested.map((c) => ({ cardId: c.cardId, id: c.id, kind: c.kind, name: c.name, needs: c.needs, risk: c.risk, skipped: c.skippedFiles })), ...state.recommended.map((r) => ({ cardId: r.cardId, id: r.id, kind: r.kind, name: r.name, needs: r.needs, risk: r.risk, skipped: 0 }))];
  const c = all.find((x) => x.cardId === cardId) ?? all[0];
  const tool = c.kind === 'tool';
  const labels = (id: string) => ({ id, label: TARGETS.find((x) => x.id === id)?.label ?? id });
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    risk: c.risk,
    needs: c.needs,
    skippedFiles: c.skipped,
    writes: agents.map((a) => ({
      kind: tool ? 'tool' : 'skill',
      agents: [labels(a)],
      path: tool ? (a === 'codex' ? '~/.codex/config.toml' : '~/.claude.json') : `~/.${a === 'codex' ? 'codex' : 'claude'}/skills/${c.id}/SKILL.md`,
      status: 'add',
      reason: null,
      text: tool ? TOOL_TEXT : SKILL_TEXT,
    })),
    canAdd: agents.length > 0,
    blocked: agents.length > 0 ? null : 'Pick an agent first.',
  };
}

/** A `ShelfApi` for tests and the dev harness. `calls` lists every call as `name(json args)`. Pass `over` to fail or change one. */
export function fakeShelfApi(state: ShelfState = shelfState(), over: Partial<ShelfApi> = {}): ShelfApi & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string, args: unknown[]) => calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
  const api: ShelfApi & { calls: string[] } = {
    calls,
    state: async () => state,
    suggest: async (itemId, to, why) => {
      rec('suggest', [itemId, to, why]);
      return { sent: true, id: itemId };
    },
    preview: async (cardId, agents) => {
      rec('preview', [cardId, agents]);
      return previewFor(cardId, agents, state);
    },
    add: async (cardId, agents, trusted) => {
      rec('add', [cardId, agents, trusted]);
      const p = previewFor(cardId, agents, state);
      const done: ShelfApplied = { id: p.id, name: p.name, kind: p.kind, addedTo: agents.map((a) => TARGETS.find((x) => x.id === a)?.label ?? a), agentIds: agents, writes: p.writes, undo: 'undo-token-1' };
      return done;
    },
    undo: async (token, itemId) => {
      rec('undo', [token, itemId]);
      return { restored: 1, skipped: [] };
    },
    dismiss: async (cardId) => {
      rec('dismiss', [cardId]);
      return true;
    },
    ...over,
  };
  return api;
}
