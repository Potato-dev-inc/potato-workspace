// Sameness guard v1 (static half). A screen never knows which PC it shows: only `lib/host/*` (the far host and the wiring that makes it) may
// import the PC link (`lib/runtime/pclink`). A component that does is a second chat screen waiting to drift. The files below still do, from
// before the one pane screen; each names the phase that moves it behind the host. The list only ever shrinks: a new file fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const rel = (f: string) => relative(src, f).split(sep).join('/');
const code = (f: string) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);
// The PC link itself, its client factory and its readers (level, usage, outbox): everything that speaks to another PC.
const importsPcLink = (text: string) => /from\s+['"][^'"]*runtime\/(pclink|remote|farLevel|farUsage)['"]/.test(text);

/** Components that still import the PC link, and the phase that moves each behind the host (`useHost()`). Shrink only. */
const STILL_DIRECT: Record<string, string> = {
  'components/chat/MoveSheet.tsx': 'Phase 4 (hand a chat to another PC)',
  'components/cockpit/UsageBar.tsx': 'Phase 5 (usage on the host)',
  'components/devices/NewAgentWhere.tsx': 'Phase 2 (New agent page on a host)',
  'components/devices/RemoteFolderSheet.tsx': 'Phase 2 (New agent page on a host)',
  'components/devices/RemoteTerminal.tsx': 'Phase 2 (a real far terminal)',
  'components/devices/useDeviceGroups.ts': 'Phase 2 (far registry rows on the host)',
};

describe('sameness guard v1: no component talks to the PC link', () => {
  const importers = walk(join(src, 'components'))
    .filter(code)
    .filter((f) => importsPcLink(readFileSync(f, 'utf8')))
    .map(rel)
    .sort();

  it('only the listed files import lib/runtime/pclink, and the list only shrinks', () => {
    expect(importers).toEqual(Object.keys(STILL_DIRECT).sort());
  });

  it('the chat screen (components/chat, components/cockpit/PaneView) never imports it, and none of its files name another PC', () => {
    for (const f of walk(join(src, 'components', 'chat')).filter(code).filter((x) => !(rel(x) in STILL_DIRECT))) {
      const text = readFileSync(f, 'utf8');
      expect(importsPcLink(text), rel(f)).toBe(false);
      expect(text, rel(f)).not.toMatch(/place\.kind|['"]dev:|['"]device:/);
    }
    for (const f of ['components/cockpit/PaneView.tsx', 'components/cockpit/rail/SessionRail.tsx']) {
      const text = readFileSync(join(src, f), 'utf8');
      expect(importsPcLink(text), f).toBe(false);
      expect(text, f).not.toMatch(/place\.kind|['"]dev:|['"]device:/);
    }
  });

  it('the host files are where it lives: lib/host/far.ts imports it, localHost never does', () => {
    expect(importsPcLink(readFileSync(join(src, 'lib/host/far.ts'), 'utf8'))).toBe(true);
    expect(importsPcLink(readFileSync(join(src, 'lib/host/local.ts'), 'utf8'))).toBe(false);
  });
});
