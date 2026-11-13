// The thin progress line of an agent's task list, under a name in the sidebar or on a board tile. Nothing when the
// pane has no list or it is finished.
import { usePlanProgress } from '../../lib/planProgress';
import '../../styles/plan-bar.css';

export function PlanLine({ paneId }: { paneId: string }) {
  const progress = usePlanProgress(paneId);
  if (!progress) return null;
  return (
    <span
      className="ck-plan-line"
      role="progressbar"
      aria-label={`${progress.done} of ${progress.total} steps done`}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
      data-testid="plan-line"
      title={progress.current ? `${progress.done} of ${progress.total} · ${progress.current}` : `${progress.done} of ${progress.total}`}
    >
      <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
    </span>
  );
}
