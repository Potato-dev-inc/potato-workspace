// The number on the app icon: how many chats need you. Uses the Badging API where the phone has it (an installed web app on
// Android and iOS); anywhere else, and on any error, it does nothing. 0 clears the badge.
import { useEffect } from 'react';

type BadgeNav = Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

export function setAppBadgeCount(count: number): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as BadgeNav;
  const n = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  try {
    const done = n > 0 ? nav.setAppBadge?.(n) : (nav.clearAppBadge?.() ?? nav.setAppBadge?.(0));
    void done?.catch(() => undefined);
  } catch {
    /* no badge on this phone */
  }
}

/** Keep the icon number equal to `count`; clear it when the app closes or the count drops to 0. */
export function useAppBadge(count: number): void {
  useEffect(() => {
    setAppBadgeCount(count);
  }, [count]);
  useEffect(() => () => setAppBadgeCount(0), []);
}
