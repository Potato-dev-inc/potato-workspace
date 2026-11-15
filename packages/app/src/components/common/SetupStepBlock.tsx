// One set-up that runs by itself: the steps in plain words ("Working…", "Done", "Tried 3 times") and, when a step
// still fails, one plain sentence, one main button ("Let Claude fix it") and the raw output folded under "Details".
// Every self-running set-up in the app draws this block, so a failure looks the same everywhere and never ends in a
// wall of text. No command is shown on its face. The caller runs the steps and owns the hand-off; this file is only
// the picture.
import { useState } from 'react';
import { useT } from '../../i18n';
import { AgentLogo } from './AgentLogo';
import '../../styles/setup-step.css';

export type SetupStepStatus = 'waiting' | 'running' | 'retrying' | 'done' | 'failed';

export interface SetupStep {
  /** Stable id, also written as `data-step` (tests and screenshots read it). */
  id: string;
  /** What this step does, in plain words. */
  label: string;
  status: SetupStepStatus;
  /** How many times it ran so far: "Tried 2 times. Trying again…". */
  tries?: number;
  /** One line under the label, only while this step is the current one (e.g. the browser approval). */
  note?: string;
  /** What the last run printed. Behind "Details", never on the face of the step. */
  output?: string;
}

export interface SetupStepBlockProps {
  /** The steps, in the order they run. A step that has not started says nothing about itself. */
  steps: readonly SetupStep[];
  /** The step that failed: the failure box shows. */
  failedId?: string | null;
  /** One plain sentence for the failure. Default: "{step} did not work." */
  failureSentence?: string;
  /** Hands the job to the person's agent (the caller reuses the existing chat hand-off). */
  onFix?: () => void;
  /** The agent that gets the job: the fix button says "Let <agent> fix it" and wears its logo. Default: Claude. */
  fixAgent?: { id: string; label: string } | null;
  /** A chat is opening: the fix button waits and says so. */
  fixing?: boolean;
  /** The job went to an agent: one line under the buttons. */
  handed?: string | null;
  /** The quiet second button in the failure box. */
  onRetry?: () => void;
  /** The run worked: one line under the steps. */
  done?: string | null;
  /** Under the fix button: the copy-the-note fallback when no agent can chat. */
  children?: React.ReactNode;
  /** Base of the test ids: `-block`, `-steps`, `-failed`, `-details`, `-done`, `-fix`, `-retry`, `-handed`. */
  testId?: string;
  className?: string;
}

/** "Waiting", "Working…", "Tried 2 times. Trying again…", "Done", "Tried 3 times". */
function stateWords(t: ReturnType<typeof useT>, step: SetupStep): string {
  switch (step.status) {
    case 'running':
      return t('setupStep.status.running');
    case 'retrying':
      return t('setupStep.status.retrying', { n: String(step.tries ?? 0) });
    case 'done':
      return t('setupStep.status.done');
    case 'failed':
      return t('setupStep.status.failed');
    default:
      return t('setupStep.status.waiting');
  }
}

/**
 * The raw output, closed by default. The toggle is held in React state (not left to the browser) so the same
 * behaviour is testable and a re-render never loses it.
 */
function RawDetails({ testId, steps }: { testId: string; steps: readonly SetupStep[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <details className="ss-details" data-testid={testId} open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        {t('setupStep.details')}
      </summary>
      {steps.map((s) => (
        <div key={s.id} className="ss-details-part">
          <small>{s.label}</small>
          <pre>{s.output}</pre>
        </div>
      ))}
    </details>
  );
}

export function SetupStepBlock({
  steps,
  failedId = null,
  failureSentence,
  onFix,
  fixAgent = null,
  fixing = false,
  handed = null,
  onRetry,
  done = null,
  children,
  testId = 'setup-step',
  className,
}: SetupStepBlockProps) {
  const t = useT();
  const failed = failedId ? steps.find((s) => s.id === failedId) : undefined;
  const printed = steps.filter((s) => s.output);
  // The step that failed speaks first under Details; the ones that worked follow.
  const outputs = failedId ? [...printed.filter((s) => s.id === failedId), ...printed.filter((s) => s.id !== failedId)] : printed;
  const details = outputs.length > 0 ? <RawDetails testId={`${testId}-details`} steps={outputs} /> : null;

  return (
    <div className={`ss-block${className ? ` ${className}` : ''}`} data-testid={`${testId}-block`}>
      <ol className="ss-steps" data-testid={`${testId}-steps`} aria-live="polite">
        {steps.map((s, index) => (
          <li key={s.id} className="ss-step" data-step={s.id} data-status={s.status}>
            <span className="ss-num" aria-hidden="true">
              {s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : index + 1}
            </span>
            <span className="ss-text">
              <span className="ss-label">{s.label}</span>
              {s.note && <small data-testid={`${testId}-note-${s.id}`}>{s.note}</small>}
            </span>
            <span className="ss-state">{stateWords(t, s)}</span>
          </li>
        ))}
      </ol>

      {done && (
        <p className="ss-done" data-testid={`${testId}-done`} role="status">
          {done}
        </p>
      )}

      {failedId && (
        <div className="ss-fail" data-testid={`${testId}-failed`}>
          <p className="ss-fail-line" role="alert">
            {failureSentence ?? t('setupStep.failedSentence', { step: failed?.label ?? t('setupStep.failedStep') })}
          </p>
          <p className="ss-fail-tried">{t('setupStep.tried', { n: String(failed?.tries ?? 3) })}</p>
          {(onFix || onRetry) && (
            <div className="ss-fail-actions">
              {onFix && (
                <button
                  type="button"
                  className="ss-btn ss-btn--primary"
                  data-testid={`${testId}-fix`}
                  disabled={fixing}
                  onClick={onFix}
                >
                  <AgentLogo id={fixAgent?.id ?? 'claude'} size={13} decorative className="ss-btn-mark" />
                  {fixAgent ? t('setupStep.fixAgent', { agent: fixAgent.label }) : t('setupStep.fix')}
                </button>
              )}
              {onRetry && (
                <button type="button" className="ss-btn" data-testid={`${testId}-retry`} disabled={fixing} onClick={onRetry}>
                  {t('setupStep.retry')}
                </button>
              )}
            </div>
          )}
          {fixing && (
            <p className="ss-note" role="status">
              {t('setupStep.fixing')}
            </p>
          )}
          {handed && (
            <p className="ss-note" data-testid={`${testId}-handed`} role="status">
              {handed}
            </p>
          )}
          {children}
          {details}
        </div>
      )}

      {!failedId && details}
    </div>
  );
}
