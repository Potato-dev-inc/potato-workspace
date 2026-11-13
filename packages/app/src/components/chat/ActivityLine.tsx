// The line that stands for a run of tool rows in a turn: "Read 6 files · Ran 2 commands · Edited 3 files · 48s".
// Click it to open the rows. While the turn runs, it shows a live spinner and the running row's label instead, a timer
// beside it, and a short step list under it (a spinner turning into a tick as each step ends). Open, a finished turn
// ends with "Done in 14s · 4 steps".
import { useEffect, useState } from 'react';
import type { ToolStep } from '../../lib/sessionChatModel';
import { DotSpinner } from '../cockpit/DotSpinner';
import '../../styles/cockpit-chat-activity.css';
import '../../styles/chat-agent-cards.css';
import {
  activitySpanMs,
  activitySummary,
  activitySummaryParts,
  doneSummary,
  runningLabel,
  stepElapsedMs,
  stepLabel,
  type SummaryPart,
} from './chatActivity';
import { CheckIcon, Chevron, CrossIcon, PendingMark, SpinMark } from './chatCardIcons';
import { formatDuration } from './chatFormat';
import { useStepsFindOpen } from './chatFind';
import { ToolRow } from './ToolRow';

export interface ActivityLineProps {
  steps: ToolStep[];
  /** The turn has no end yet: a row without a result is then live. */
  live: boolean;
  fromScreen: boolean;
  /** Verbose: the line and its rows start open. */
  verbose: boolean;
}

/** How many steps the live list shows (the newest). */
const LIVE_STEPS = 5;

/** The summary's groups as text, with each "(N failed)" in a stronger style, then the time when there is one. */
function SummaryText({ parts, time }: { parts: SummaryPart[]; time: string | null }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part.text}
          {part.failed !== null && (
            <span className="ck-chat-activity-failed">
              {' '}
              {part.failed}
            </span>
          )}
        </span>
      ))}
      {time !== null && ` · ${time}`}
    </>
  );
}

/** Milliseconds since the first step began (its time when it has one, else since this line first showed). */
function useElapsed(steps: readonly ToolStep[], live: boolean): number {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  const parsed = Date.parse(steps[0]?.call.at ?? '');
  const start = Number.isNaN(parsed) ? mountedAt : parsed;
  return Math.max(0, now - start);
}

function StepMark({ step, live }: { step: ToolStep; live: boolean }) {
  if (step.status === 'error') return <CrossIcon />;
  if (step.status === 'ok') return <CheckIcon />;
  return live ? <SpinMark /> : <PendingMark />;
}

export function ActivityLine({ steps, live, fromScreen, verbose }: ActivityLineProps) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const foundHere = useStepsFindOpen(steps);
  const open = toggled ?? (verbose || foundHere);
  const running = live ? runningLabel(steps) : null;
  const summary = activitySummary(steps);
  const span = live ? null : activitySpanMs(steps);
  const parts = activitySummaryParts(steps);
  const elapsed = useElapsed(steps, live);
  const shown = steps.slice(-LIVE_STEPS);
  return (
    <div className="ck-chat-activity-wrap ck-agc-group" data-live={live || undefined}>
      <div className="ck-agc-grouphead">
        <button
          type="button"
          aria-expanded={open}
          title={summary}
          onClick={() => setToggled(!open)}
          className="ck-chat-activity ck-agc-grouptoggle"
          data-live={running !== null || undefined}
        >
          {running !== null && <DotSpinner status="running" size={3} label="Working" className="shrink-0" />}
          <span className={`ck-chat-activity-text ck-agc-grouptext${running !== null ? ' ck-agc-shim' : ''}`}>
            {running !== null ? `Working · ${running}` : <SummaryText parts={parts} time={span !== null ? formatDuration(span) : null} />}
          </span>
          <Chevron />
        </button>
        {live && (
          <span className="ck-agc-elapsed" data-testid="activity-elapsed" aria-label="Time so far">
            {formatDuration(elapsed)}
          </span>
        )}
      </div>
      {live && !open && (
        <ol className="ck-agc-steps" aria-label="Steps" data-testid="activity-steps">
          {shown.map((step) => {
            const ms = stepElapsedMs(step);
            return (
              <li key={step.id} className={`ck-agc-step ck-agc-step--${step.status}`} data-status={step.status}>
                <span className="ck-agc-step-mark">
                  <StepMark step={step} live={live} />
                </span>
                <span className={`ck-agc-step-text${step.status === 'running' ? ' ck-agc-shim' : ''}`} title={stepLabel(step)}>
                  {stepLabel(step)}
                </span>
                {ms !== null && <span className="ck-agc-step-time">{formatDuration(ms)}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {open && (
        <div className="ck-chat-activity-rows ck-agc-rows">
          {steps.map((step) => (
            <ToolRow key={step.id} step={step} fromScreen={fromScreen} defaultOpen={verbose} live={live} />
          ))}
          {!live && steps.length > 0 && (
            <p className="ck-agc-done" data-testid="activity-done">
              <CheckIcon />
              {doneSummary(steps)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
