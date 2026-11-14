// The one line a turn's finished steps fold into: "Read 3 files · Edited 2 files". One tap opens the list (each step is a row
// that opens for its detail). While the turn still works, the line says what is running now.
import { useState } from 'react';
import { useT } from '../../i18n';
import type { ToolStep } from '../../lib/sessionChatModel';
import { countActivity, runningLabel } from '../chat/chatActivity';
import { Chevron } from '../chat/chatCardIcons';
import { ToolRow } from '../chat/ToolRow';
import { DotSpinner } from '../cockpit/DotSpinner';
import '../../styles/phone-shell.css';

export function FoldedSteps({ steps, live, fromScreen }: { steps: ToolStep[]; live: boolean; fromScreen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = live ? runningLabel(steps) : null;
  const count = t('phone.fold.steps', { count: steps.length });
  // Finished: what was done, in words ("Read 3 files · Edited 2 files"). The time is said once, in the header.
  const done = countActivity(steps).map((part) => t(`phone.fold.kind.${part.kind}`, { count: part.count })).join(' · ');
  const line = running !== null ? t('phone.fold.live', { steps: count }) : done !== '' ? done : count;
  return (
    <div className="ph-fold" data-testid="phone-fold" data-open={open || undefined}>
      <button type="button" className="ph-fold-line" aria-expanded={open} aria-label={`${line}. ${open ? t('phone.fold.hide') : t('phone.fold.show')}`} onClick={() => setOpen((v) => !v)}>
        {running !== null && <DotSpinner status="running" size={3} className="shrink-0" />}
        <span className="ph-fold-text">{line}</span>
        <Chevron />
      </button>
      {running !== null && !open && <p className="ph-fold-now">{running}</p>}
      {open && (
        <div className="ph-fold-rows">
          {steps.map((step) => (
            <ToolRow key={step.id} step={step} fromScreen={fromScreen} live={live} />
          ))}
        </div>
      )}
    </div>
  );
}
