// The app's own local server: other tools and agents reach Potato Workspace through it. Running = the app has found its
// address. Plain words only: the person never needs to know what the server is called.
import { t } from '../../i18n';
import type { CheckRow, SetupCheckContext } from './types';

export function checkBridge(ctx: SetupCheckContext): CheckRow[] {
  return [
    ctx.bridgeUrl
      ? { id: 'bridge', status: 'ok', sentence: t('overview.check.bridge.ok'), fix: null }
      : { id: 'bridge', status: 'fail', sentence: t('overview.check.bridge.restart'), fix: null },
  ];
}
