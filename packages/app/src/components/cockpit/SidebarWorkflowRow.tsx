// One quiet row under a workflow's front agent in the sidebar: "Workflow: Research + Write · 2 working · 1 needs you".
// Clicking it opens the front chat with the live view open. It is there while the front has started agents, and stays as "done"
// until the front chat closes (like the crew chip). Same look as the standby rows: no edge stripe, the label shrinks with an
// ellipsis, and it has no hover buttons that could cover it.
import { useT } from '../../i18n';
import { workflowCounts, workflowLine, workflowName, workflowTone } from '../../lib/workflow-model';
import type { LiveHelper } from '../../lib/workflow-live';
import '../../styles/standby-rows.css';
import '../../styles/workflow-dock.css';

export function SidebarWorkflowRow({ frontId, name, helpers, active, onOpen }: { frontId: string; name: string | null; helpers: ReadonlyArray<Pick<LiveHelper, 'state'>>; active: boolean; onOpen: (frontId: string) => void }) {
  const t = useT();
  const line = workflowLine(name, helpers, t);
  const tone = workflowTone(helpers);
  return (
    <div className="ck-rowwrap ck-sb-wrap" data-testid="workflow-row" data-front={frontId} data-tone={tone}>
      <button
        type="button"
        className={`ck-row ck-row--slim ck-sb-row ck-wf-row${active ? ' is-active' : ''}`}
        data-tone={tone}
        aria-label={t('wfdock.row.aria', { line })}
        title={`${line}\n${t('wfdock.row.tip')}`}
        onClick={() => onOpen(frontId)}
      >
        <span className="ck-row-glyph">
          <span className="ck-wf-dot" aria-hidden="true" />
        </span>
        <span className="ck-row-main">
          <span className="ck-row-title ck-wf-name" data-testid="workflow-row-name">
            {workflowName(name, t)}
          </span>
          <span className="ck-wf-counts" data-testid="workflow-row-counts">
            {workflowCounts(helpers, t)}
          </span>
        </span>
      </button>
    </div>
  );
}
