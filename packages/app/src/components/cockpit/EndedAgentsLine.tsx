// One calm line when terminal agents did not survive the last restart: Reopen starts each again in its folder.
import { useState } from 'react';
import { useT } from '../../i18n';
import { endedLine, type RememberedTerminal } from './session-memory';
import '../../styles/ended-agents-line.css';

export function EndedAgentsLine({ ended, onReopen, onDismiss }: { ended: RememberedTerminal[]; onReopen: () => Promise<void>; onDismiss: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (ended.length === 0) return null;
  return (
    <div className="ck-ended" role="status" aria-label={t('inbox.endedAgents')} title={ended.map((t) => t.title || t.agent).join(', ')}>
      <span>{endedLine(ended.length)}</span>
      <button
        type="button"
        className="ck-btn ck-btn--secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onReopen().finally(() => setBusy(false));
        }}
      >
        {t('common.reopen')}
      </button>
      <button type="button" className="ck-ended-link" onClick={onDismiss}>
        {t('common.dismiss')}
      </button>
    </div>
  );
}
