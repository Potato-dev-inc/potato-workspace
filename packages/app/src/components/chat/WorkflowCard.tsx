// One compact row at the top of a chat that started from a workflow: "Using workflow: <name>". Closed, it is the
// size of a minion row. Open, it shows the whole brief the agent was told (read only, scrolls), so nothing is hidden.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { WorkflowSplit } from '../../lib/workflowCard';
import { holdsQuery, useFindQuery } from './chatFind';

/** Three linked dots: a flow. Not the minion cube or the spin-off branch. */
function FlowGlyph() {
  return (
    <svg className="ck-chat-wf-glyph" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="3.5" cy="8" r="1.6" />
      <circle cx="12.5" cy="4" r="1.6" />
      <circle cx="12.5" cy="12" r="1.6" />
      <path d="M5 7.4 11 4.6M5 8.6l6 2.8" />
    </svg>
  );
}

export function WorkflowCard({ split, defaultOpen = false }: { split: WorkflowSplit; defaultOpen?: boolean }) {
  const t = useT();
  const [toggled, setToggled] = useState<boolean | null>(null);
  // A search that matches the brief opens the card by itself, so the match can be seen.
  const open = toggled ?? (defaultOpen || holdsQuery(split.brief, useFindQuery()));
  const label = t('workflowCard.using', { name: split.name });
  return (
    <div className="ck-chat-wf w-full self-stretch" data-testid="workflow-card">
      <button
        type="button"
        aria-expanded={open}
        title={open ? t('workflowCard.hide') : t('workflowCard.show')}
        onClick={() => setToggled(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-0.5 text-left hover:bg-pm-raised ck-chat-tool ck-chat-helper-row ck-chat-wf-row"
      >
        <FlowGlyph />
        <span className="min-w-0 flex-1 truncate text-pm-text ck-chat-helper-text" title={label}>
          {label}
        </span>
        <svg className="shrink-0 text-pm-muted" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="ck-chat-wf-text mt-0.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-pm-raised px-2 py-1 text-xs text-pm-text" data-testid="workflow-card-text" tabIndex={0}>
          {split.brief}
        </div>
      )}
    </div>
  );
}
