// Huge pastes freeze a text box (the browser lays the whole text out on every change; 207,500 chars took 5.7 s, 830,000 took 176 s).
// Above PASTE_MAX_CHARS a paste is refused with a plain sentence. Above BIG_TEXT_CHARS the box stops measuring itself and per-change scans are skipped.
export const PASTE_MAX_CHARS = 200_000;
export const BIG_TEXT_CHARS = 50_000;

/** True (and the paste cancelled) when the pasted text is too big to take. The caller shows its own message. */
export function refusePaste(event: { clipboardData: DataTransfer | null; preventDefault: () => void }): boolean {
  const pasted = event.clipboardData?.getData('text/plain') ?? '';
  if (pasted.length <= PASTE_MAX_CHARS) return false;
  event.preventDefault();
  return true;
}

/** Grows a text box to its text up to `maxPx`; a huge text is not measured (a forced layout of all of it), it just gets the full height. */
export function growBox(el: HTMLTextAreaElement, maxPx: number): void {
  if (el.value.length > BIG_TEXT_CHARS) {
    el.style.height = `${maxPx}px`;
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
}
