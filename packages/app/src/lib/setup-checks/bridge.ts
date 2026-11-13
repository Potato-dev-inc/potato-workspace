// The app's own local server: other tools and agents reach Potato Workspace through it. Running = the app has found its
// address. Plain words only: the person never needs to know what the server is called.
import type { CheckRow, SetupCheckContext } from './types';

export function checkBridge(ctx: SetupCheckContext): CheckRow[] {
  return [
    ctx.bridgeUrl
      ? { id: 'bridge', status: 'ok', sentence: 'Potato Workspace is running', fix: null }
      : { id: 'bridge', status: 'fail', sentence: 'Potato Workspace needs a restart. Close it and open it again.', fix: null },
  ];
}
