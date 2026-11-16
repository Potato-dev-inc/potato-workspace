/**
 * Entry for the config commands: `status`, `settings`, `labs`, `agents`, `models`, `projects`, `standby`.
 * Returns the process exit code; index.ts calls `process.exit` with it.
 */
import { createInterface } from 'node:readline/promises';
import { CONFIG_USAGE, parseConfigArgs } from './args.js';
import { CliError, DEFAULT_CONSENT_WAIT_MS, EXIT, createBridge, type Bridge, type BridgeOptions } from './bridge.js';
import { runLabs, runSettings } from './commands/settings.js';
import { runStandby } from './commands/standby.js';
import { runCrew } from './commands/crew.js';
import { runAgents, runModels, runProjects, runStatus } from './commands/read.js';
import { runConfig } from './commands/config.js';
import type { Io } from './output.js';

export function terminalIo(): Io {
  // Inside an agent window the shell carries a pane id; there is no person at that keyboard to type y.
  const inAgentWindow = Boolean((process.env.POTATO_WORKSPACE_PANE_ID ?? '').trim());
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !inAgentWindow,
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

export async function runConfigCli(
  argv: string[],
  io: Io,
  cliVersion: string,
  makeBridge: (options: BridgeOptions) => Bridge = createBridge,
): Promise<number> {
  const args = parseConfigArgs(argv);
  if ('problem' in args) {
    io.err(`potato-workspace: ${args.problem}`);
    io.err(CONFIG_USAGE);
    return EXIT.failed;
  }
  if (args.help) {
    io.out(CONFIG_USAGE);
    return EXIT.ok;
  }
  const bridge = makeBridge({
    consentWaitMs: args.waitMs ?? DEFAULT_CONSENT_WAIT_MS,
    note: (line) => io.err(line),
  });
  const ctx = { bridge, io, args, cliVersion };
  try {
    switch (args.command) {
      case 'settings':
        return await runSettings(ctx);
      case 'labs':
        return await runLabs(ctx);
      case 'status':
        return await runStatus(ctx);
      case 'agents':
        return await runAgents(ctx);
      case 'models':
        return await runModels(ctx);
      case 'projects':
        return await runProjects(ctx);
      case 'crew':
        return await runCrew(ctx);
      case 'standby':
        return await runStandby(ctx);
      case 'config':
        return await runConfig(ctx);
      default:
        io.err(CONFIG_USAGE);
        return EXIT.failed;
    }
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`potato-workspace ${args.command}: ${err.message}`);
      return err.exitCode;
    }
    io.err(`potato-workspace ${args.command}: ${(err as Error).message}`);
    return EXIT.failed;
  }
}
