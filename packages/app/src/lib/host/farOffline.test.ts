import { describe, expect, it } from 'vitest';
import { useEnglish } from '../../i18n/test-utils';
import { whenOffline } from './useFarPane';
import type { Host } from './host';

useEnglish();
const host = { denied: (cap: string) => (cap === 'message' ? 'watch only' : null) } as unknown as Host;

describe('a far chat while its PC is off', () => {
  it('the message box says the PC is offline, not "watch only"', () => {
    const off = whenOffline(host, { state: 'offline', name: 'Mac mini' } as never);
    expect(off.denied?.('message')).toBe('Mac mini is offline. Its work keeps running there.');
    expect(off.denied?.('change')).toBeNull();
  });
  it('a level never read while the PC is off: every control says the PC is off, not "needs Full"', () => {
    const never = { denied: () => 'needs Full' } as unknown as Host;
    expect(whenOffline(never, { state: 'offline', name: 'Mac mini' } as never, false).denied?.('change')).toBe('Mac mini is offline. Its work keeps running there.');
    expect(whenOffline(never, { state: 'offline', name: 'Mac mini' } as never, true).denied?.('change')).toBe('needs Full');
  });
  it('an online PC keeps its own words', () => {
    expect(whenOffline(host, { state: 'online', name: 'Mac mini' } as never)).toBe(host);
  });
});
