/** Flag parsing shared by the config commands (settings, labs, status, agents, models, projects). */

export interface ConfigArgs {
  command: string;
  positional: string[];
  json: boolean;
  yes: boolean;
  dryRun: boolean;
  help: boolean;
  waitMs?: number;
}

export const CONFIG_COMMANDS = new Set(['settings', 'labs', 'status', 'agents', 'models', 'projects']);

export const CONFIG_USAGE = `usage:
  potato-workspace status
  potato-workspace settings list | get KEY | set KEY VALUE [KEY VALUE ...] | reset KEY
  potato-workspace labs list | on KEY | off KEY
  potato-workspace agents list
  potato-workspace models list AGENT
  potato-workspace projects list
flags: --json  --yes (apply a change)  --dry-run (show only)  --wait-ms N (wait for the Allow card)
exit codes: 0 ok, 1 failed, 4 app not reachable, 5 needs --yes (nothing changed), 6 refused`;

const KNOWN = new Set(['json', 'yes', 'y', 'dry-run', 'help', 'h', 'wait-ms']);

/** The parsed args, or `{ problem }` for a flag the commands do not know. */
export function parseConfigArgs(argv: string[]): ConfigArgs | { problem: string } {
  const [command = '', ...rest] = argv;
  const out: ConfigArgs = { command, positional: [], json: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    // A value such as -1 or "-" is a value, not a flag.
    if (!a.startsWith('--') && !(a.startsWith('-') && /^-[a-z]/i.test(a))) {
      out.positional.push(a);
      continue;
    }
    const key = a.replace(/^-+/, '');
    if (!KNOWN.has(key)) return { problem: `unknown flag ${a}` };
    switch (key) {
      case 'json':
        out.json = true;
        break;
      case 'yes':
      case 'y':
        out.yes = true;
        break;
      case 'dry-run':
        out.dryRun = true;
        break;
      case 'help':
      case 'h':
        out.help = true;
        break;
      case 'wait-ms': {
        const n = Number(rest[++i]);
        if (!Number.isFinite(n) || n < 0) return { problem: '--wait-ms needs a number of milliseconds' };
        out.waitMs = n;
        break;
      }
    }
  }
  return out;
}

/** `lend_enabled` style names only; anything else is a typo or an attempt at something else. */
export function isKeyName(text: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(text);
}
