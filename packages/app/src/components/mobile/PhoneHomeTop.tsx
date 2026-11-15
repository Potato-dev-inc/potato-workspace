// The top line of the phone home: the PC this phone is connected to (plain text for now; switching
// between PCs comes later) and one small setup chip that opens the existing three steps.
import { useT } from '../../i18n';
import '../../styles/phone-home.css';

export function PhoneHomeTop({
  setup,
}: {
  /** How many setup steps are done, and what opens them. The chip hides when all are done. */
  setup?: { done: number; total: number; onOpen: () => void };
}) {
  const t = useT();
  return (
    <div className="ph-home-top">
      <p className="ph-place" data-testid="phone-place">
        {t('phone.place.mainPc')}
      </p>
      {setup && setup.done < setup.total && (
        <button type="button" className="ph-setup-chip" data-testid="phone-setup-chip" onClick={setup.onOpen}>
          {t('phone.setup.chip', { done: setup.done, total: setup.total })}
        </button>
      )}
    </div>
  );
}
