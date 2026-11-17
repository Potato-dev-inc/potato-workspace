// The one quiet offer on Connect: "Keep the same link every time". It appears only after something real hurt
// (the quick address changed and a phone dropped, or Team was opened for the first time) and never before the first
// phone scan has worked. "Not now" hides it for about two weeks. Saved in this browser only; every read and write is guarded.
export const OFFER_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

const FIRST_SCAN = 'pm.connect.firstScanWorked';
const SNOOZE_UNTIL = 'pm.connect.stableOffer.until';
const TEAM_SEEN = 'pm.connect.stableOffer.teamSeen';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* no storage here: the offer simply does not remember */
  }
}

/** True once a phone has really connected (so the offer may ever show). */
export function firstScanWorked(): boolean {
  return read(FIRST_SCAN) === '1';
}
export function markFirstScan(): void {
  if (!firstScanWorked()) write(FIRST_SCAN, '1');
}

export function offerSnoozed(now: number = Date.now()): boolean {
  const until = Number(read(SNOOZE_UNTIL));
  return Number.isFinite(until) && until > now;
}
export function snoozeOffer(now: number = Date.now()): void {
  write(SNOOZE_UNTIL, String(now + OFFER_SNOOZE_MS));
}

/** Team opened for the first time (after a first scan worked)? Counts the moment once. */
export function teamFirstOpenPain(): boolean {
  return firstScanWorked() && read(TEAM_SEEN) !== '1';
}
export function markTeamOfferSeen(): void {
  write(TEAM_SEEN, '1');
}
