import { useState } from 'react';
import { bindingLabel } from '../../lib/shortcuts';
import { Sheet } from './Sheet';
import '../../styles/individual-mode.css';

/** The first time Individual mode is picked from the cockpit: what will happen, with a way out. */
export function IndividualSheet({ onSwitch, onCancel }: { onSwitch: (dontShowAgain: boolean) => void; onCancel: () => void }) {
  const [dontShow, setDontShow] = useState(true);
  return (
    <Sheet className="ck-explain" labelledBy="ck-explain-t" onClose={onCancel}>
      <h2 className="ck-section" id="ck-explain-t">
        Switch to Individual mode?
      </h2>
      <p className="ck-sub">
        Each agent gets its own window and this main window hides. A small bar stays at the top of your screen: use it to
        jump between agents or to go back to Orchestration{bindingLabel('mode-toggle') ? ` (${bindingLabel('mode-toggle')} does the same)` : ''}.
      </p>
      <label className="ck-explain-check">
        <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
        Don't show this again
      </label>
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ck-btn ck-btn--primary" autoFocus onClick={() => onSwitch(dontShow)}>
          Switch
        </button>
      </div>
    </Sheet>
  );
}
