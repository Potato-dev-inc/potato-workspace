// What a chat says while its conversation is open in a terminal pane: the chat is paused (its message box is switched off
// in PaneView), with the way back and a link to the terminal.
import { useT, t } from '../../i18n';
import '../../styles/cockpit-acp.css';

export const HANDED_NOTE = 'This conversation is open in a terminal';
export const HANDED_BLOCK = 'This conversation is open in a terminal. Go back to chat to write here.';
export const handedBlock = (): string => t('state.chat.handedBlock');

export function HandedToTerminal({ terminalPaneId, busy, onBack, onGoToTerminal }: { terminalPaneId: string | null; busy: boolean; onBack: () => void; onGoToTerminal: (paneId: string) => void }) {
  const t = useT();
  return (
    <div className="ck-acp-strip ck-acp-handed" data-testid="acp-handed">
      <span className="ck-acp-strip-text" role="status">
        {t('state.chat.handedNote')}
      </span>
      <span className="ck-acp-handed-actions">
        {terminalPaneId && (
          <button type="button" className="ck-acp-link" onClick={() => onGoToTerminal(terminalPaneId)}>
            {t('state.chat.goToTerminal')}
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--secondary" disabled={busy} onClick={onBack}>
          {t('state.chat.backToChat')}
        </button>
      </span>
    </div>
  );
}
