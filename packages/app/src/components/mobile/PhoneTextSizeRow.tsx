// Settings row: Text size Small / Normal / Large. Only this phone changes (lib/phone-text-size.ts keeps it in localStorage and
// sets `--fs` on the `.ph` shell). The three choices are one radio group so a screen reader says which is on.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { PHONE_TEXT_SIZE_EVENT, parsePhoneTextSize, readPhoneTextSize, setPhoneTextSize, type PhoneTextSize } from '../../lib/phone-text-size';
import '../../styles/phone-link.css';

const SIZES: readonly PhoneTextSize[] = ['small', 'normal', 'large'];

export function PhoneTextSizeRow() {
  const t = useT();
  const [size, setSize] = useState<PhoneTextSize>(readPhoneTextSize);
  useEffect(() => {
    const on = (event: Event) => setSize(parsePhoneTextSize((event as CustomEvent<unknown>).detail));
    window.addEventListener(PHONE_TEXT_SIZE_EVENT, on);
    return () => window.removeEventListener(PHONE_TEXT_SIZE_EVENT, on);
  }, []);
  const label = (s: PhoneTextSize) => (s === 'small' ? t('phone.text.small') : s === 'large' ? t('phone.text.large') : t('phone.text.normal'));
  return (
    <div className="ph-group" data-testid="phone-text-size">
      <div className="ph-row ph-textsize">
        <span className="ph-rowtext" id="ph-textsize-label">{t('phone.text.title')}</span>
        <div className="ph-seg" role="radiogroup" aria-labelledby="ph-textsize-label">
          {SIZES.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={size === s} data-size={s} onClick={() => setPhoneTextSize(s)}>
              {label(s)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
