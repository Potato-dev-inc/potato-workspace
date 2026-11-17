// The live view as a card at the top of a workflow front's chat, for when the details column is hidden or too narrow:
// one line ("Workflow: Research + Write · 2 working · 1 needs you") with a chevron that opens the live view inline.
import { useState } from 'react';
import { useT } from '../../i18n';
import { workflowLine, type WorkflowModel } from '../../lib/workflow-model';
import { IconChevronDown } from '../cockpit/Icons';
import { WorkflowLive } from './WorkflowLive';
import '../../styles/workflow-dock.css';

export function WorkflowCard({ model, onOpenHelper, onOpenBig }: { model: WorkflowModel; onOpenHelper: (helperId: string) => void; onOpenBig?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const line = workflowLine(model.name, model.helpers, t);
  return (
    <section className={`wfl-card${open ? ' is-open' : ''}`} data-testid="wf-card" aria-label={t('wfdock.pane')}>
      <button type="button" className="wfl-card-head" data-testid="wf-card-head" aria-expanded={open} title={t(open ? 'wfdock.card.hide' : 'wfdock.card.show')} onClick={() => setOpen((v) => !v)}>
        <span className="wfl-card-text" data-testid="wf-card-line">
          {line}
        </span>
        <span className="wfl-chev" aria-hidden="true">
          <IconChevronDown />
        </span>
      </button>
      {open ? <WorkflowLive model={model} onOpenHelper={onOpenHelper} onOpenBig={onOpenBig} showSummary={false} /> : null}
    </section>
  );
}
