// THE seam "Use my own agents" (and any far start that needs an agent that may be missing) calls before it goes on:
//   `ensureInstalledOnFar(host, agentId)`: 'ready' when the agent is on that PC (already, or after the person let it be installed there),
//   'cancelled' when the person said Not now or stopped it. It asks the far PC (`agents_detect_installed`); only when the agent is missing it
//   shows the "Install <agent> on <PC>?" sheet (`components/devices/FarInstallSheet.tsx`), which `FarInstallHost` (mounted once in the cockpit)
//   registers here. With no screen to ask on nothing is installed and the answer is 'cancelled'.
import { installedOnFar } from './farInstall';
import type { Host } from './host';

export type EnsureResult = 'ready' | 'cancelled';

export interface InstallRequest {
  host: Host;
  agentId: string;
  /** The sheet calls this once, with how it ended. */
  finish: (result: EnsureResult) => void;
}

let present: ((request: InstallRequest) => void) | null = null;
// One sheet at a time: a second ask waits for the first one's answer.
let line: Promise<unknown> = Promise.resolve();

/** The cockpit says how to show the sheet (null: it went away). */
export function registerInstallPresenter(show: ((request: InstallRequest) => void) | null): void {
  present = show;
}

export function ensureInstalledOnFar(host: Host, agentId: string): Promise<EnsureResult> {
  const turn = line.then(async (): Promise<EnsureResult> => {
    // An older far PC has no detect row: nothing can be asked or installed there, so the caller's own start says what it says.
    if (host.can && !host.can('agents_detect_installed')) return 'ready';
    if (await installedOnFar(host, agentId)) return 'ready';
    const show = present;
    if (!show) return 'cancelled';
    return new Promise<EnsureResult>((finish) => show({ host, agentId, finish }));
  });
  line = turn.catch(() => undefined);
  return turn;
}
