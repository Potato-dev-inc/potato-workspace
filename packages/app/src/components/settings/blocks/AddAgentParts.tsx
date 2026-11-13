// The small pieces of the Add-an-agent box: the step list, the capability chips and the install screen.
// All words come from lib/addAgent.ts. Nothing here names an agent.
import { useState } from 'react';
import { CHIPS, chipMark, nameOf, sourceText, stepLine, type AddAgentRun, type AgentCaps } from '../../../lib/addAgent';
import { DotSpinner } from '../../cockpit/DotSpinner';
import { Btn } from '../settings-ui';

/** One line per planned step. Pending lines are dim; a running line shows its timer. */
export function StepList({ run, receivedAt, now }: { run: AddAgentRun; receivedAt: number; now: number }) {
  const name = nameOf(run);
  const caps = run.result?.caps ?? null;
  return (
    <ul className="aa-steps" aria-label="Progress">
      {run.steps.map((step) => {
        const text = stepLine(step, name, caps);
        if (text === null) return null;
        const running = step.state === 'running';
        const seconds = running ? Math.floor(((step.elapsed_ms ?? 0) + Math.max(0, now - receivedAt)) / 1000) : 0;
        return (
          <li key={step.id} className={`aa-step is-${step.state}`} data-step={step.id} data-state={step.state}>
            <span className="aa-mark" aria-hidden="true">
              {running ? <DotSpinner status="running" size={3} label="Working" /> : step.state === 'done' ? '✓' : step.state === 'failed' ? '✕' : step.state === 'skipped' ? '–' : <span className="aa-pending-dot" />}
            </span>
            <span className="aa-step-text">
              {text}
              {running && step.limit_ms > 0 && (
                <span className="aa-step-time">
                  {seconds} s (up to {Math.round(step.limit_ms / 1000)} s)
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** One chip. Yes = filled with a tick, no = outline with a cross, unknown = dashed outline with no mark. */
function Chip({ chipKey, label, caps, name }: { chipKey: (typeof CHIPS)[number]['key']; label: string; caps: AgentCaps; name: string }) {
  const cap = caps[chipKey];
  const tip = sourceText(cap.source, name);
  const mark = chipMark(cap.value);
  return (
    <li
      className={`aa-chip is-${cap.value}`}
      data-chip={chipKey}
      data-value={cap.value}
      tabIndex={0}
      aria-label={`${label}: ${cap.value === 'yes' ? 'yes' : cap.value === 'no' ? 'no' : 'not seen yet'}. ${tip}`}
    >
      <span className="aa-chip-label">{label}</span>
      {mark && (
        <span className="aa-chip-mark" data-mark={cap.value}>
          {mark}
        </span>
      )}
      <span className="aa-tip" role="tooltip">
        {tip}
      </span>
    </li>
  );
}

/** The chips of a finished chat agent. Known ones first (yes, then no); the ones not seen yet are one line of text, not a column of pills. */
export function Chips({ caps, name }: { caps: AgentCaps; name: string }) {
  const ordered = [...CHIPS.filter(({ key }) => caps[key].value === 'yes'), ...CHIPS.filter(({ key }) => caps[key].value === 'no')];
  const unknown = CHIPS.filter(({ key }) => caps[key].value === 'unknown');
  return (
    <div className="aa-chipwrap" role="group" aria-label="What it can do">
      {ordered.length > 0 && (
        <ul className="aa-chips">
          {ordered.map(({ key, label }) => (
            <Chip key={key} chipKey={key} label={label} caps={caps} name={name} />
          ))}
        </ul>
      )}
      {unknown.length > 0 && (
        <p className="aa-quiet aa-caption" data-testid="aa-unknown-count">
          {unknown.length} more fill in after your first chat
        </p>
      )}
    </div>
  );
}

/** What will run, as a disclosure. The lines are raw commands and are not part of the plain-words rule. */
export function WhatWillRun({ lines, host }: { lines: string[]; host: string }) {
  return (
    <details className="aa-details">
      <summary>
        What will run{host ? <span data-raw="true"> · from {host}</span> : null}
      </summary>
      <pre className="aa-cmd" data-raw="true">
        {lines.join('\n')}
      </pre>
    </details>
  );
}

/** The install screen. The click on the install button is the only approval. */
export function InstallScreen({
  run,
  busy,
  onInstall,
  onNotNow,
  onCheckAgain,
  onTerminal,
}: {
  run: AddAgentRun;
  busy: boolean;
  onInstall: () => void;
  onNotNow: () => void;
  onCheckAgain: () => void;
  onTerminal: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const install = run.install;
  if (!install) return null;
  const name = install.label || nameOf(run);
  const command = install.what_will_run.join('\n');
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(command);
    } catch {
      // no clipboard: the command stays on screen to select
    }
    setCopied(true);
  };
  if (install.kind === 'chat_addon') {
    return (
      <div className="aa-body">
        <h3 className="aa-title">{name} needs a small add-on to chat.</h3>
        <p className="aa-sub">Without it, {name} works in a terminal only.</p>
        <WhatWillRun lines={install.what_will_run} host={install.source_host} />
        <div className="aa-actions">
          <Btn primary disabled={busy} onClick={onInstall}>
            Install the add-on
          </Btn>
          <Btn disabled={busy} onClick={onTerminal}>
            Use it in a terminal instead
          </Btn>
        </div>
      </div>
    );
  }
  if (install.can_install) {
    return (
      <div className="aa-body">
        <h3 className="aa-title">{name} is not on this computer yet.</h3>
        <p className="aa-sub">Potato can install it for you.</p>
        <WhatWillRun lines={install.what_will_run} host={install.source_host} />
        <div className="aa-actions">
          <Btn primary disabled={busy} onClick={onInstall}>
            Install {name}
          </Btn>
          <Btn disabled={busy} onClick={onNotNow}>
            Not now
          </Btn>
        </div>
      </div>
    );
  }
  return (
    <div className="aa-body">
      <h3 className="aa-title">{name} is not on this computer yet.</h3>
      <p className="aa-sub">Run this in a terminal, then check again.</p>
      <div className="aa-cmdbox">
        <pre className="aa-cmd" data-raw="true">
          {command}
        </pre>
        <Btn small className="aa-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Btn>
      </div>
      <p className="aa-quiet">A terminal is the black window where you type commands.</p>
      <div className="aa-actions">
        <Btn primary disabled={busy} onClick={onCheckAgain}>
          Check again
        </Btn>
        <Btn disabled={busy} onClick={onNotNow}>
          Not now
        </Btn>
      </div>
    </div>
  );
}
