import { useState } from 'react';
import { useT } from '../../i18n';
import { bindingLabel } from '../../lib/shortcuts';
import { Sheet } from './Sheet';
import '../../styles/individual-mode.css';

/** The first time Individual mode is picked from the cockpit: what will happen, with a way out. */
export function IndividualSheet({ onSwitch, onCancel }: { onSwitch: (dontShowAgain: boolean) => void; onCancel: () => void }) {
  const t = useT();
  const [dontShow, setDontShow] = useState(true);
  return (
    <Sheet className="ck-explain" labelledBy="ck-explain-t" onClose={onCancel}>
      <h2 className="ck-section" id="ck-explain-t">
        {t('individual.title')}
      </h2>
      <p className="ck-sub">{t('individual.body', { same: bindingLabel('mode-toggle') ? ` ${t('individual.same', { keys: bindingLabel('mode-toggle') })}` : '' })}</p>
      <label className="ck-explain-check">
        <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
        {t('individual.dontShow')}
      </label>
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onCancel}>
          {t('lend.cancel')}
        </button>
        <button type="button" className="ck-btn ck-btn--primary" autoFocus onClick={() => onSwitch(dontShow)}>
          {t('individual.switch')}
        </button>
      </div>
    </Sheet>
  );
}
