// Tells the PC this phone's name (its model, from the user agent and Client Hints) when it connects, and again only when it
// changed. The PC keeps it as the phone's own name; a name the person gave the phone on the PC always wins.
import { useEffect } from 'react';
import type { BridgeClient } from '../lib/bridge-types';
import { readPhoneName } from '../lib/phoneName';

export const TOLD_NAME_KEY = 'pm-told-device-name';

export function usePhoneName(bridge: BridgeClient | null): void {
  useEffect(() => {
    if (!bridge?.tellName) return;
    let live = true;
    void readPhoneName()
      .then((name) => {
        if (!live) return;
        let told: string | null = null;
        try {
          told = localStorage.getItem(TOLD_NAME_KEY);
        } catch {
          // Storage is blocked: tell the PC every time, it is one small request.
        }
        if (told === name) return;
        return bridge.tellName?.(name).then(() => {
          try {
            localStorage.setItem(TOLD_NAME_KEY, name);
          } catch {
            // Not kept: told again next time.
          }
        });
      })
      // An old PC without the route, or a dropped link: tried again next time.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);
}
