// One calm line when terminal agents did not survive the last restart: Reopen starts each again in its folder.
import { useState } from 'react';
import { endedLine, type RememberedTerminal } from './session-memory';
import '../../styles/focus-note.css';

export function EndedAgentsLine({ ended, onReopen, onDismiss }: { ended: RememberedTerminal[]; onReopen: () => Promise<void>; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  if (ended.length === 0) return null;
  return (
    <div className="ck-focus-note ck-ended" role="status" aria-label="Agents that ended" title={ended.map((t) => t.title || t.agent).join(', ')}>
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
        Reopen
      </button>
      <button type="button" className="ck-focus-note-link" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
