// The phone's text size: Small 14, Normal 15, Large 17 (px). Only the `--fs` token changes (styles/phone.css reads
// `data-text` on the `.ph` shell); every other size is worked out from it. Kept on this phone only, in localStorage.
// The phone Settings screen sets it with setPhoneTextSize(); until then it stays Normal.
import { useEffect, type RefObject } from 'react';

export type PhoneTextSize = 'small' | 'normal' | 'large';
export const PHONE_TEXT_SIZE_KEY = 'potato.phone.textSize.v1';
export const PHONE_TEXT_SIZE_EVENT = 'potato:phone-text-size';

export function parsePhoneTextSize(raw: unknown): PhoneTextSize {
  return raw === 'small' || raw === 'large' ? raw : 'normal';
}

export function readPhoneTextSize(): PhoneTextSize {
  try {
    return parsePhoneTextSize(localStorage.getItem(PHONE_TEXT_SIZE_KEY));
  } catch {
    return 'normal';
  }
}

export function setPhoneTextSize(size: PhoneTextSize): void {
  try {
    localStorage.setItem(PHONE_TEXT_SIZE_KEY, size);
  } catch {
    /* storage blocked: the size still applies for this visit */
  }
  window.dispatchEvent(new CustomEvent<PhoneTextSize>(PHONE_TEXT_SIZE_EVENT, { detail: size }));
}

/** Put the size on the `.ph` shell that holds `ref`, and follow changes (this tab, another tab). */
export function usePhoneTextSize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const shell = ref.current?.closest<HTMLElement>('.ph');
    if (!shell) return;
    const apply = (size: PhoneTextSize) => {
      if (size === 'normal') delete shell.dataset.text;
      else shell.dataset.text = size;
    };
    apply(readPhoneTextSize());
    const onEvent = (event: Event) => apply(parsePhoneTextSize((event as CustomEvent<unknown>).detail));
    const onStorage = (event: StorageEvent) => {
      if (event.key === PHONE_TEXT_SIZE_KEY) apply(readPhoneTextSize());
    };
    window.addEventListener(PHONE_TEXT_SIZE_EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PHONE_TEXT_SIZE_EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, [ref]);
}
