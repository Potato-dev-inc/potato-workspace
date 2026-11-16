// "Stuck? No progress for 6 min" with Nudge, Stop and Respawn, for a helper that stopped making progress.
// Drawn under the helper's row in the rail and above the composer in the helper's own chat. Nothing when it is not stuck.
import { useT } from '../../i18n';
import { tauriStallApi, useStall, type StallApi } from '../../lib/stalls';
import { useStallActions, type StallAction } from './useStallActions';
import '../../styles/stall-notice.css';

export function StallNotice({ paneId, compact, api = tauriStallApi }: { paneId: string; compact?: boolean; api?: StallApi }) {
  const t = useT();
  const minutes = useStall(paneId);
  const { busy, note, run } = useStallActions(paneId, api);
  if (minutes === null) return null;
  const button = (which: StallAction, danger?: boolean) => (
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
