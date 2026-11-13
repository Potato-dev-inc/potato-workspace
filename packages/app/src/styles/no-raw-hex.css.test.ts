// Guard: a style file must use colour tokens, not raw hex colours. The token files define the colours;
// every other file is listed below with the number of raw hex colours it still has. The numbers only go down:
// a new hex colour fails this test, and so does a lower count that was not written down here (lower the number).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Files that define the tokens: any number of hex colours. */
const TOKEN_FILES = new Set(['cockpit.css', 'phone.css', 'askbar.css', 'point-box.css', 'settings.css', 'theme.css']);

/** Existing raw hex colours outside the token files (comments excluded). Only lower these. */
const ALLOWED: Record<string, number> = {
  'addAgent.css': 2,
  'app-update.css': 1,
  'close-confirm.css': 5,
  'cockpit-chat.css': 1,
  'cockpit-hidden-agents.css': 2,
  'cockpit-live.css': 2,
  'history.css': 1,
  'individual-mode.css': 4,
  'lend.css': 40,
  'model-picker.css': 3,
  'project-file-picker.css': 2,
  'settings-rows.css': 11,
  'simple.css': 1,
  'switch-overlay.css': 6,
  'terminal.css': 1,
  'uninstall.css': 2,
};

const HEX = /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b/g;
const countHex = (css: string): number => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Only a hex in a value, not an id selector: a value follows ':' or ',' or '(' and the hex ends at ; ) , whitespace or end.
  return [...bare.matchAll(/[:,(]\s*[^;{}]*?(#[0-9a-fA-F]{3,8})\b(?![\w-])/g)].filter((m) => /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(m[1])).length;
};

describe('no raw hex colours outside the token files', () => {
  const dir = __dirname;
  const files = readdirSync(dir).filter((f) => f.endsWith('.css'));
  for (const f of files) {
    if (TOKEN_FILES.has(f)) continue;
    it(`${f} has at most ${ALLOWED[f] ?? 0} raw hex colours`, () => {
      const n = countHex(readFileSync(join(dir, f), 'utf8'));
      const allowed = ALLOWED[f] ?? 0;
      expect(n, `${f}: use a colour token (--label, --accent, --live, --risk, --danger, --bg...) instead of a hex colour`).toBeLessThanOrEqual(allowed);
      expect(n, `${f} now has fewer hex colours: lower its number in ALLOWED`).toBeGreaterThanOrEqual(allowed);
    });
  }
  it('the allow-list names only files that exist', () => {
    for (const f of Object.keys(ALLOWED)) expect(files).toContain(f);
  });
  it('the check itself sees a hex colour and ignores comments and ids', () => {
    expect(countHex('.a { color: #fff; }')).toBe(1);
    expect(countHex('.a { color: var(--x, #1b1a19); }')).toBe(1);
    expect(countHex('/* #fff */ #root { margin: 0 }')).toBe(0);
  });
});
