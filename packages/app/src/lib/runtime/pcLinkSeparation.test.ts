// Founder rule: PC to PC is not the phone. This pins (1) that no remote-PC screen uses a phone component or a phone style, and
// (2) that the desktop's remote runtime calls NO phone route, phone bridge method or phone type: another PC is spoken to through
// the PC link's own `/pclink/` routes (`lib/runtime/pclink.ts`) and nothing else. The list of allowed phone calls is EMPTY and
// stays empty: a new use fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const screens = (dirs: string[]) => dirs.flatMap((d) => walk(join(root, d))).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));

/** The phone bridge methods the remote runtime may still call, per file. EMPTY: every remote call is a `/pclink/` route. */
const ALLOWED_PHONE_CALLS: Record<string, string[]> = {};

/** Everything that talks to, or draws, another PC. */
const REMOTE_FILES = [
  'lib/runtime/remote.ts',
  'lib/host/far.ts',
  'lib/host/farCockpit.ts',
  'lib/host/useFarPane.ts',
  'lib/runtime/remoteNewAgent.ts',
  'lib/runtime/pclink.ts',
  'lib/runtime/farLevel.ts',
  'lib/moveChat.ts',
  'components/devices/FarPane.tsx',
  'components/devices/RemoteTerminal.tsx',
  'components/devices/NewAgentWhere.tsx',
  'components/devices/useDeviceGroups.ts',
  'components/devices/FullAskNotice.tsx',
  'components/chat/MoveSheet.tsx',
];

describe('PC to PC is separate from the phone', () => {
  it('no remote-PC screen (devices/, cockpit/newagent/) imports a phone component or style, or builds a ph- class', () => {
    for (const f of screens(['components/devices', 'components/cockpit/newagent'])) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"]\.\.\/(\.\.\/)?mobile\//);
      expect(src, f).not.toMatch(/phone-(shell|chat)\.css/);
      // "ph", "ph-x", `ph ${...}`, 'ph', "ph" in either quote style or a template.
      expect(src, f).not.toMatch(/['"`]ph([ -][^'"`]*)?['"`]/);
      expect(src, f).not.toMatch(/\bph-[a-z]/);
    }
  });

  it('the allowlist of phone calls in the remote runtime is empty, and nothing in it uses a bridge.phone* method', () => {
    expect(ALLOWED_PHONE_CALLS).toEqual({});
    for (const rel of REMOTE_FILES) {
      const src = stripComments(read(rel));
      const used = [...new Set(src.match(/\bbridge\??\.phone[A-Za-z]+/g) ?? [])].sort();
      expect(used, rel).toEqual([]);
      // Any `.phoneXyz(` call or `phoneXyz` name at all (a client method, a destructured one, a string key).
      expect(src, rel).not.toMatch(/\.phone[A-Z]/);
    }
  });

  it('the remote runtime names no phone or generic bridge route: only /pclink/ paths', () => {
    for (const rel of REMOTE_FILES) {
      const src = stripComments(read(rel));
      for (const bad of ['/phone', '/panes', '/acp/', '/control-asks', '/questions', '/pane-rules', '/events', '/attention', '/settings']) {
        expect(src, `${rel} names ${bad}`).not.toContain(`'${bad}`);
        expect(src, `${rel} names ${bad}`).not.toContain(`\`${bad}`);
        expect(src, `${rel} names ${bad}`).not.toContain(`"${bad}`);
      }
    }
  });

  it('the remote runtime imports no phone client, phone event reader, phone outbox or phone-shaped types', () => {
    for (const rel of REMOTE_FILES) {
      const src = stripComments(read(rel));
      expect(src, rel).not.toMatch(/from ['"](\.\.\/)+(lib\/)?bridge['"]/);
      expect(src, rel).not.toMatch(/from ['"](\.\.\/)+(lib\/)?bridge-sse['"]/);
      expect(src, rel).not.toMatch(/from ['"](\.\.\/)+(lib\/)?bridge-types['"]/);
      expect(src, rel).not.toMatch(/paneOutbox-bridge/);
      expect(src, rel).not.toMatch(/\bmakeBridgeClient\b|\bBridgeClient\b|\bPhoneNewChat|\bPhoneChatReply\b|\bdispatchBridgeEvent\b|\bBridgeTransport\b/);
    }
  });

  it('a screen of another PC decides nothing from this PC\'s own grant: the far level comes from the far PC (`/pclink/me`)', () => {
    for (const rel of ['components/devices/RemoteTerminal.tsx', 'components/devices/NewAgentWhere.tsx', 'components/chat/MoveSheet.tsx']) {
      const src = stripComments(read(rel));
      expect(src, rel).not.toMatch(/\bpicked\.level\b|\bdevice\.level\b/);
      expect(src, rel).toContain('useFarLevel');
    }
  });

  it('the far host reaches the far PC only through the PC link: it names no bridge, no loopback address and no port (S1)', () => {
    for (const rel of ['lib/host/far.ts', 'lib/host/farCockpit.ts', 'lib/host/useFarPane.ts']) {
      const src = stripComments(read(rel));
      expect(src, rel).not.toMatch(/bridge-url|bridge-sse|127.0.0.1|localhost|.phone[A-Z]/);
    }
  });
});
