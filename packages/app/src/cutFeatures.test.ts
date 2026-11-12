// @vitest-environment node
// The features cut in the Settings rebuild stay gone: Focus Time, the Recorder (Rec button), Clip It, Tag Your Agent
// and the moving tray icon. Settings has no row (or search hit) for them, no component or command wrapper of them
// is left, and the Rust command list no longer registers their Tauri commands. Discord alerts took the place of
// Tag Your Agent.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './components/settings/catalog';
import { rowMatches } from './components/settings/model';

const SRC = __dirname;
const RUST = join(SRC, '..', 'src-tauri', 'src');

const CUT_COMMANDS = [
  'focus_state',
  'focus_start',
  'focus_extend',
  'focus_end',
  'focus_settings_set',
  'focus_summary_dismiss',
  'recorder_start',
  'recorder_status',
  'recorder_stop',
  'agents_drafts_list',
  'agents_draft_validate',
  'clip_plan',
  'clip_stage',
  'clip_save',
  'telegram_tag_bot',
  'telegram_tag_set_enabled',
  'telegram_tag_set_caps',
  'telegram_tag_approve',
  'telegram_tag_ignore',
  'telegram_tag_update_group',
  'telegram_tag_remove',
  'ambient_get_prefs',
  'ambient_set_animated_tray',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const tsFiles = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('cutFeatures.test.ts'));

describe('Settings has no row for the cut features', () => {
  const rows = SECTIONS.flatMap((s) => s.rows);

  it('has no focus-time, animated-tray, tag or recorder row', () => {
    const ids = rows.map((r) => r.id);
    for (const gone of ['focus-time', 'animated-tray', 'telegram-tag', 'recorder', 'clip']) expect(ids).not.toContain(gone);
  });

  it('search finds none of them', () => {
    for (const query of ['focus time', 'quiet during focus', 'animated tray', 'tray icon', 'moving dot', 'tag your agent', 'tag bot', 'recorder', 'rec button', 'make clip', 'clip it']) {
      expect(rows.filter((r) => rowMatches(r, query)).map((r) => r.id), query).toEqual([]);
    }
  });

  it('has the Discord alerts row in General, with a short hint, and search finds it', () => {
    const general = SECTIONS.find((s) => s.id === 'general')!;
    const row = general.rows.find((r) => r.id === 'discord-alerts');
    expect(row?.label).toBe('Discord alerts');
    expect((row?.hint ?? '').length).toBeLessThanOrEqual(90);
    for (const query of ['discord', 'webhook', 'discord alerts']) expect(rows.filter((r) => rowMatches(r, query)).map((r) => r.id), query).toContain('discord-alerts');
  });
});

describe('the cut code is gone', () => {
  it('has none of the cut components, hooks or libraries', () => {
    for (const gone of [
      'components/cockpit/FocusNote.tsx',
      'components/cockpit/FocusPill.tsx',
      'components/cockpit/palette-focus.ts',
      'components/mobile/FocusBar.tsx',
      'components/settings/blocks/FocusSettings.tsx',
      'components/settings/blocks/AmbientSettings.tsx',
      'components/settings/blocks/TelegramTagBot.tsx',
      'components/chat/ClipSheet.tsx',
      'components/chat/useClipMaker.ts',
      'hooks/useFocus.ts',
      'lib/focus.ts',
      'lib/clipEncode.ts',
      'lib/clipDraw.ts',
      'lib/mp4Mux.ts',
    ]) {
      expect(existsSync(join(SRC, gone)), gone).toBe(false);
    }
  });

  it('has no TypeScript wrapper that calls a cut Tauri command', () => {
    const hits: string[] = [];
    for (const file of tsFiles) {
      const text = readFileSync(file, 'utf8');
      for (const name of CUT_COMMANDS) if (new RegExp(`['"\`]${name}['"\`]`).test(text)) hits.push(`${file.slice(SRC.length + 1)}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it('registers none of the cut commands in the Rust handler list, and has no cut Rust module', () => {
    const lib = readFileSync(join(RUST, 'lib.rs'), 'utf8');
    const registered = new Set([...lib.matchAll(/commands::([a-z0-9_]+),/g)].map((m) => m[1]));
    expect(CUT_COMMANDS.filter((name) => registered.has(name))).toEqual([]);
    for (const mod of ['agent_definitions_recorder', 'clip', 'ambient/tray_icon', 'ambient/glyph', 'attention/focus', 'channels/setup_tag', 'channels/tag_config']) {
      expect(existsSync(join(RUST, mod)) || existsSync(join(RUST, `${mod}.rs`)), mod).toBe(false);
    }
    for (const name of ['discord_alerts_status', 'discord_alerts_set_url', 'discord_alerts_clear', 'discord_alerts_set_kinds', 'discord_alerts_test']) {
      expect(registered.has(name), name).toBe(true);
    }
  });

  it('keeps no bridge route for Focus', () => {
    expect(existsSync(join(RUST, 'bridge', 'routes', 'focus.rs'))).toBe(false);
    const routes = readFileSync(join(RUST, 'bridge', 'routes', 'mod.rs'), 'utf8');
    expect(routes).not.toMatch(/focus::handle|mod focus/);
  });
});
