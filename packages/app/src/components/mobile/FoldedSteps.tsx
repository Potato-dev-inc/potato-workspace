// The one line a turn's finished steps fold into: "Read 3 files · Edited 2 files". While the turn still works, the line
// says what runs now in plain words ("Reading login.ts", "Running tests"), never the command. One tap opens the list
// (each step is a row that opens for its detail).
import { useState } from 'react';
import { useT } from '../../i18n';
import type { ToolStep } from '../../lib/sessionChatModel';
import { countActivity } from '../chat/chatActivity';
import { Chevron } from '../chat/chatCardIcons';
import { ToolRow } from '../chat/ToolRow';
import { DotSpinner } from '../cockpit/DotSpinner';
import { liveLine, runningStep } from './foldSteps';
import { RollText } from './RollText';
import '../../styles/phone-shell.css';

export function FoldedSteps({ steps, live, fromScreen }: { steps: ToolStep[]; live: boolean; fromScreen: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const now = live ? runningStep(steps) : null;
  const count = t('phone.fold.steps', { count: steps.length });
  // Finished: what was done, in words ("Read 3 files · Edited 2 files"). The time is said once, in the header.
  const done = countActivity(steps).map((part) => t(`phone.fold.kind.${part.kind}`, { count: part.count })).join(' · ');
  const doneLine = done !== '' ? done : count;
  const line = now !== null ? liveLine(now) : null;
  const label = line === null ? doneLine : line.thing === null ? line.verb : `${line.verb} ${line.thing}`;
  return (
    <div className="ph-fold" data-testid="phone-fold" data-open={open || undefined}>
      <button type="button" className="ph-fold-line" aria-expanded={open} aria-label={`${label}. ${open ? t('phone.fold.hide') : t('phone.fold.show')}`} onClick={() => setOpen((v) => !v)}>
        {line !== null && <DotSpinner status="running" size={3} className="shrink-0" />}
        <RollText text={label} className="ph-fold-text">
          {line === null ? undefined : (
            <>
              <span className="ph-live-verb">{line.verb}</span>
              {line.thing !== null && (
                <>
                  {' '}
                  <span className="ph-live-thing">{line.thing}</span>
                </>
              )}
            </>
          )}
        </RollText>
        <Chevron />
      </button>
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
