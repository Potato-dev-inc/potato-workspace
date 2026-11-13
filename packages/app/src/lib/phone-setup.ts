// Setup after pairing (phone part 2, P19): three steps (Home Screen, notifications, a test), shown once after a phone is paired and again
// from Settings > Help. This file holds the small pure parts: which help to show, the "show once" flag, and the local test notification.

export type PhonePlatform = 'ios' | 'android' | 'other';

export function platformOf(userAgent: string, maxTouchPoints = 0): PhonePlatform {
  if (/iPad|iPhone|iPod/.test(userAgent) || (userAgent.includes('Mac') && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}

const LS_SETUP = 'pm.phone.setup';

/** Called when a phone has just been paired: the steps show once. */
export function markSetupPending(): void {
  try {
    if (localStorage.getItem(LS_SETUP) === null) localStorage.setItem(LS_SETUP, 'pending');
  } catch {
    /* private mode: no steps, nothing breaks */
  }
}

export function setupPending(): boolean {
  try {
    return localStorage.getItem(LS_SETUP) === 'pending';
  } catch {
    return false;
  }
}

export function markSetupDone(): void {
  try {
    localStorage.setItem(LS_SETUP, 'done');
  } catch {
    /* private mode */
  }
}

export type TestResult = 'sent' | 'no-permission' | 'unsupported' | 'failed';

/**
 * Shows one notification from this phone itself (through the app's service worker), so the person sees that the phone is willing to show
 * notifications at all. It does not travel through the PC: a message from the PC needs a push route that is not built yet.
 */
export async function sendLocalTestNotification(title: string, body: string): Promise<TestResult> {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  if (Notification.permission !== 'granted') return 'no-permission';
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, { body, tag: 'pm-test' });
    return 'sent';
  } catch {
    return 'failed';
  }
}
