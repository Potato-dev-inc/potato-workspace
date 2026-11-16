// "Stuck? No progress for 6 min" with Nudge, Stop and Respawn, for a helper that stopped making progress.
// Drawn under the helper's row in the rail and above the composer in the helper's own chat. Nothing when it is not stuck.
import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { tauriStallApi, useStall, type StallApi } from '../../lib/stalls';
import '../../styles/stall-notice.css';

type Which = 'nudge' | 'stop' | 'respawn';

export function StallNotice({ paneId, compact, api = tauriStallApi }: { paneId: string; compact?: boolean; api?: StallApi }) {
  const t = useT();
  const minutes = useStall(paneId);
  const [busy, setBusy] = useState<Which | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (minutes === null) return null;
  const run = async (which: Which) => {
    setBusy(which);
    setNote(null);
    try {
      await api[which](paneId);
      setNote(t(which === 'nudge' ? 'stall.nudged' : which === 'stop' ? 'stall.stopped' : 'stall.respawned'));
    } catch (e) {
      setNote(errorSentence(e, t('stall.failed')));
    } finally {
      setBusy(null);
    }
  };
  const button = (which: Which, danger?: boolean) => (
    <button type="button" className={`stall-btn${danger ? ' is-danger' : ''}`} title={t(`stall.${which}Tip`)} disabled={busy !== null} onClick={() => void run(which)}>
      {t(`stall.${which}`)}
    </button>
  );
  return (
    <div className={`stall-notice${compact ? ' is-compact' : ''}`} role="status" data-testid="stall-notice">
      <span className="stall-line">{t('stall.line', { n: minutes })}</span>
      <span className="stall-actions">
        {button('nudge')}
        {button('stop', true)}
        {button('respawn')}
      </span>
      {note && <span className="stall-note">{note}</span>}
    </div>
  );
}
