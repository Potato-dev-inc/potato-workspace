// Remembers (in this browser only) that a phone has really connected once, so "Scan again." can show when the quick
// address changes later. The one-time "keep the same link" offer is gone: the relay card above the tabs replaces it.
// Every read and write is guarded.
const FIRST_SCAN = 'pm.connect.firstScanWorked';

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
    /* no storage here: it simply does not remember */
  }
}

/** True once a phone has really connected. */
export function firstScanWorked(): boolean {
  return read(FIRST_SCAN) === '1';
}
export function markFirstScan(): void {
  if (!firstScanWorked()) write(FIRST_SCAN, '1');
}
