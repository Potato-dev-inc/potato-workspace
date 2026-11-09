// The "Agents in the New agent menu" editor: one row per agent with a checkbox (ticked = shown in the menu),
// a "Show all" reset and an optional Back/Done button. Used by the New agent menu ("Edit list…") and by the
// Settings row. At least one agent always stays shown: the last shown row cannot be unticked.
import { canHideAgent, useHiddenAgents } from '../../../lib/hiddenAgents';
import '../../../styles/cockpit-hidden-agents.css';

export interface EditableAgent {
  type: string;
  label: string;
}

interface Props {
  /** Every agent that could appear in the menu (not only the shown ones). */
  entries: readonly EditableAgent[];
  /** Back in the menu, Done in Settings. Without it no button is drawn. */
  onBack?: () => void;
  backLabel?: string;
}

export function HiddenAgentsEditor({ entries, onBack, backLabel = 'Back' }: Props) {
  const { hidden, setAgentHidden, showAll } = useHiddenAgents();
  const shownCount = entries.filter((e) => !hidden.includes(e.type)).length;
  return (
    <div className="ck-hidden-editor" data-testid="hidden-agents-editor">
      <div className="ck-hidden-cap">Agents in the New agent menu</div>
      <p className="ck-hidden-note">Tick the agents you want to see. A hidden agent stays installed.</p>
      <div className="ck-hidden-list">
        {entries.map((e) => {
          const shown = !hidden.includes(e.type);
          // Unticking the last shown agent is refused: the box stays on and cannot be changed.
          const locked = shown && !canHideAgent(entries, hidden, e.type);
          return (
            <label key={e.type} className={locked ? 'ck-hidden-row is-locked' : 'ck-hidden-row'} title={locked ? 'Keep at least one agent shown.' : undefined}>
              <input
                type="checkbox"
                checked={shown}
                disabled={locked}
                aria-label={`Show ${e.label} in the New agent menu`}
                onChange={(ev) => setAgentHidden(e.type, !ev.target.checked)}
              />
              <span>{e.label}</span>
            </label>
          );
        })}
      </div>
      {shownCount === 1 && <p className="ck-hidden-note">Only one agent is shown. Tick another one before you can hide it.</p>}
      <div className="ck-hidden-actions">
        <button type="button" className="ck-hidden-btn" disabled={hidden.length === 0} onClick={showAll}>
          Show all
        </button>
        {onBack && (
          <button type="button" className="ck-hidden-btn ck-hidden-btn--primary" onClick={onBack}>
            {backLabel}
          </button>
        )}
      </div>
    </div>
  );
}
