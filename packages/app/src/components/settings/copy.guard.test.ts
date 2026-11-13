// The words and the saved keys of the rows: the copy table for Bridge, Models and Labs is applied, no developer
// word shows outside the Advanced page, and every row that saves a value says which keys it owns.
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './catalog';
import { ROW_META } from './row-meta';

const rows = SECTIONS.flatMap((s) => s.rows.map((row) => ({ page: s.id, row })));
const byId = (id: string) => rows.find((r) => r.row.id === id)?.row;

/** Section 6 of the settings spec: the label and hint each row now carries. */
const COPY: Record<string, [string, string]> = {
  toolbelt: ['Tools for every agent', "Add a tool server once. It is written into each agent's settings."],
  'agent-pack': ['Let agents ask each other for help', 'Teaches each agent when to ask another. Review first; Undo puts it back.'],
  'helper-tools': ['Helper tools in every agent', 'Agents you open here get the helper tools with no setup.'],
  'bridge-endpoint': ['Local address', 'Where other tools reach this app on this computer. Found by itself.'],
  'mcp-status': ['Connection check', "Checks the local address, the helper program and each agent's settings."],
  'rust-mcp': ['Use the built-in helper program', 'On: agents start the helper that ships with the app. Off: they use npx.'],
  'mcp-install': ['Connect Claude, Codex and OpenCode', 'Writes the helper program into their settings.'],
  'snippet-claude-desktop': ['Set up Claude Desktop by hand', "Copy this into Claude Desktop's settings. The app won't write it."],
  'snippet-codex': ['Set up Codex by hand', 'Copy this if you would rather not use Connect.'],
  'mcp-uninstall': ['Disconnect agents from Potato Workspace', 'Removes the app from agent settings. The app stays. Restart the agents.'],
  'librarian-indexer': ['Project index', 'Empty: OpenCode builds it. Or the path to your own script.'],
  'opencode-provider': ['OpenCode: model service', 'Used when you start OpenCode without naming a model.'],
  'opencode-model': ['OpenCode: model', 'The model used with the service above.'],
  'model-bridge': ['Another model in Codex', 'Connect a model service with a key, then add it to Codex. A backup is kept.'],
  'labs-index': ['Early features', 'Tap one to jump to its switch.'],
  'simple-mode': ['Simple look', 'A calmer screen with fewer buttons and plain words.'],
  'ask-bar': ['Ask bar', 'Ask a quick question from a small bar anywhere in Windows.'],
  'live-updates': ['Live updates', 'Claude and Codex tell the app when they start, ask and finish.'],
  'acp-chat-labs': ['Chat view', 'Use an agent as a chat instead of a terminal.'],
  missions: ['Missions', 'Give agents a goal and checks. They work until the checks pass.'],
  'night-shift': ['Night Shift', 'Agents work overnight in copies. You keep or drop each one.'],
  'assign-issue': ['Assign an issue', 'Label a GitHub issue and an agent works on it here.'],
  'red-to-green': ['Red to Green', 'When a check fails on a pull request, the same agent can fix it.'],
  'model-bridge-labs': ['Another model in Codex', 'Adds a way to use another model service inside Codex.'],
  'spaces-labs': ['Spaces', 'Chat with friends in small groups, PC to PC. No server keeps messages.'],
  'lend-labs': ['Lend an agent', 'Lend a sign-in to another PC, or borrow one. Adds a card to Connect.'],
  'desktop-potato-labs': ['Desktop Potato', 'A small Potato on your desktop. It sleeps, and waves when an agent needs you.'],
  telegram: ['Telegram', 'Answer your agents by Telegram text. Read the warning first.'],
  'opencode-automation': ['Switch OpenCode keys at the limit', "Uses your other key when one is limited. Check your provider's terms."],
};

/** Words a person should not meet outside the Advanced page. */
const BANNED = /\b(MCP|bridge|runtime|orchestrator|LLM|ACP|PTY|config|npx|daemon|headless)\b/i;

describe('the words of the rows', () => {
  it('Bridge, Models and Labs rows use the labels in the copy table', () => {
    for (const [id, [label, hint]] of Object.entries(COPY)) {
      const row = byId(id);
      expect(row, `no row ${id}`).toBeDefined();
      expect(row?.label, `${id} label`).toBe(label);
      expect(row?.hint, `${id} hint`).toBe(hint);
      expect(hint.length, `${id} hint length`).toBeLessThanOrEqual(80);
    }
  });

  it('the old words still find these rows (they stay in the keywords)', () => {
    const keywords = (id: string) => `${byId(id)?.keywords ?? ''} ${byId(id)?.label ?? ''}`.toLowerCase();
    expect(keywords('toolbelt')).toContain('toolbelt');
    expect(keywords('mcp-status')).toContain('runtime');
    expect(keywords('bridge-endpoint')).toContain('bridge');
    expect(keywords('librarian-indexer')).toContain('orchestrator');
    expect(keywords('model-bridge')).toContain('model bridge');
    expect(keywords('mcp-install')).toContain('mcp');
  });

  it('no banned word appears in a label or hint outside the Advanced page', () => {
    const found: string[] = [];
    for (const { page, row } of rows) {
      if (page === 'advanced') continue;
      for (const [part, text] of [['label', row.label], ['hint', row.hint ?? '']]) {
        const hit = BANNED.exec(text);
        if (hit) found.push(`${row.id} ${part}: ${hit[0]}`);
      }
      if (/webhook/i.test(row.label)) found.push(`${row.id} label: webhook`);
    }
    expect(found).toEqual([]);
  });
});

describe('the saved keys of the rows', () => {
  it('every row with a saved value declares its keys', () => {
    // A row that patches settings straight from its own render function must name those keys.
    const missing: string[] = [];
    for (const { row } of rows) {
      const source = row.render.toString();
      for (const m of source.matchAll(/env\.patch\(\{\s*([a-z_]+)\s*:/g)) {
        const key = m[1];
        if (['project_path', 'agent_default_models', 'helper_default_models', 'agent_hooks_agents', 'handoff_fixed_notes', 'keybindings', 'public_pwa_url', 'dev_server_port'].includes(key)) continue; // lists and folder: no dot
        if (key.includes('api_key') || key.endsWith('_key')) continue;
        if (!row.keys?.includes(key as never)) missing.push(`${row.id}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    // Rows whose patch is in a helper component are listed by hand.
    for (const [id, meta] of Object.entries(ROW_META)) {
      expect(byId(id)?.keys, `${id} keys`).toEqual(meta.keys);
    }
  });

  it('key fields, sign-ins, pairing, lists and danger rows never declare keys', () => {
    for (const { row } of rows) {
      if (row.danger || /^(key-|opencode-keys|remove-all-keys|accounts|pairing|paired-devices|shortcut)/.test(row.id)) {
        expect(row.keys, row.id).toBeUndefined();
      }
    }
  });
});
