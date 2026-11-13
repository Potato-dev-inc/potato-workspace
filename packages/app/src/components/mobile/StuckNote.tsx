// Phone: a quiet note under the tab bar when the loop guard says the open agent looks stuck
// (same error again and again, no progress, no output for a while). The PC shows the full card.
import { useT } from '../../i18n';
import type { LoopSignalInfo } from '../../lib/bridge-types';

export function StuckNote({ signal }: { signal: LoopSignalInfo }) {
  const t = useT();
  return (
    <div className="ph-note ph-note--stuck" role="note">
      <b>{t('phone.stuck.title')}</b>
      <span>{signal.summary}</span>
    </div>
  );
}
