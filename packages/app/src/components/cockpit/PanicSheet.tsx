import { useEffect, useState } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { tauriLoopApi, type StopReport } from '../../lib/loop-guard';
import { Sheet } from './Sheet';
import '../../styles/loop-guard.css';

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** "Everything is stopped": what the panic button stopped, paused, held or put to sleep. Rows only for what was running. */
export function PanicSheet({
  report: given,
  names,
  onClose,
}: {
  report: StopReport;
  names: CockpitApi['names'];
  onClose: () => void;
}) {
  // The answer of a Try again replaces the one the sheet opened with.
  const [report, setReport] = useState(given);
  useEffect(() => setReport(given), [given]);
  const [retrying, setRetrying] = useState(false);

  // Try again: the same stop-all the panic button runs (lib/loop-guard tauriLoopApi.stopAll).
  const tryAgain = () => {
    setRetrying(true);
    tauriLoopApi
      .stopAll()
      .then(setReport)
      .catch(() => {})
      .finally(() => setRetrying(false));
  };

  const agents = report.stopped.length;
  const rows: string[] = [];
  if (agents > 0) rows.push(count(agents, 'agent stopped', 'agents stopped'));

  return (
    <Sheet className="ck-panic" labelledBy="ck-panic-t" onClose={onClose}>
      <h2 className="ck-section" id="ck-panic-t">
        Everything is stopped
      </h2>
      {rows.length === 0 && report.failed.length === 0 && <p className="ck-sub">Nothing was running.</p>}
      {rows.length > 0 && (
        <ul className="ck-panic-list">
          {rows.map((row) => (
            <li key={row}>
              <span className="ck-panic-name">{row}</span>
            </li>
          ))}
        </ul>
      )}
      {report.failed.length > 0 && (
        <>
          <p className="ck-sub">Could not stop {count(report.failed.length, 'agent', 'agents')}.</p>
          <ul className="ck-panic-list">
            {report.failed.map(([id]) => (
              <li key={id}>
                <span className="ck-panic-name">{names.get(id) ?? 'An agent'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="ck-sheet-actions">
        {report.failed.length > 0 && (
          <button type="button" className="ck-btn ck-btn--secondary" disabled={retrying} onClick={tryAgain}>
            Try again
          </button>
        )}
        <button type="button" className="ck-btn ck-btn--primary" autoFocus onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}
