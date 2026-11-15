// A small chip that stays after the welcome was closed with set-up still open: it never blocks anything, and one
// press opens the welcome again where it left off.
import { useT } from '../../i18n';
import '../../styles/first-run.css';
import { T } from './copy';

export function FinishSetupChip({ onOpen }: { onOpen: () => void }) {
  useT();
  return (
    <button type="button" className="fr-chip fr-chip--button" data-testid="finish-setup-button" title={T.finishSetupHint} onClick={onOpen}>
      {T.finishSetup}
    </button>
  );
}
