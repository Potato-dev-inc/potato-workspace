// Settings row: Motion Full / Reduced. Only this phone changes (lib/phone-motion.ts keeps it in localStorage and sets
// `data-motion` on the `.ph` shell). Reduced turns slides into quick fades. One radio group so a screen reader says which is on.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { PHONE_MOTION_EVENT, parsePhoneMotion, readPhoneMotion, setPhoneMotion, type PhoneMotion } from '../../lib/phone-motion';
import '../../styles/phone-link.css';

const CHOICES: readonly PhoneMotion[] = ['full', 'reduce'];

export function PhoneMotionRow() {
  const t = useT();
  const [motion, setMotion] = useState<PhoneMotion>(readPhoneMotion);
  useEffect(() => {
    const on = (event: Event) => setMotion(parsePhoneMotion((event as CustomEvent<unknown>).detail));
    window.addEventListener(PHONE_MOTION_EVENT, on);
    return () => window.removeEventListener(PHONE_MOTION_EVENT, on);
  }, []);
  return (
    <div className="ph-group" data-testid="phone-motion">
      <div className="ph-row ph-textsize">
        <span className="ph-rowtext" id="ph-motion-label">
          {t('phone.motion.title')}
          <small style={{ display: 'block', color: 'var(--muted)' }}>{t('phone.motion.hint')}</small>
        </span>
        <div className="ph-seg" role="radiogroup" aria-labelledby="ph-motion-label">
          {CHOICES.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={motion === v} data-motion-choice={v} onClick={() => setPhoneMotion(v)}>
              {v === 'reduce' ? t('phone.motion.reduced') : t('phone.motion.full')}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
