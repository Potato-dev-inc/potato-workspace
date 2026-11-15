// The founder's rule: the app never tells the person to run a command. No component, i18n string or user-facing
// message may show the old Worker setup commands; the buttons do the steps themselves.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
const BAD = /npx wrangler|npm run deploy|cd relay|wrangler login|relay\/worker/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');

describe('no command text for the person to run', () => {
  const files = walk(SRC).filter((f) => !/[\\/]dev[\\/]/.test(f));
  it('scans the components, libs and every i18n file', () => {
    expect(files.some((f) => f.endsWith('StableLinkSheet.tsx'))).toBe(true);
    expect(files.some((f) => /i18n[\\/]en[\\/]settingsPhone\.ts$/.test(f))).toBe(true);
  });
  it('shows none of the old Worker setup commands (comments may name the repo folder; text may not)', () => {
    const hits = files.filter((f) => BAD.test(withoutComments(readFileSync(f, 'utf8')))).map((f) => f.slice(SRC.length + 1));
    expect(hits).toEqual([]);
  });
  it('the stable-link message from the backend does not name a command either', () => {
    const rust = readFileSync(join(SRC, '../src-tauri/src/mobile_tunnel/stable_link.rs'), 'utf8');
    expect(rust).not.toMatch(/npx wrangler|npm run deploy|cd relay/);
  });
});
