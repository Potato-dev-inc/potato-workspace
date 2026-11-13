// One tool call as a card: an icon for its kind, its name and what it works on (mono), a status badge, and a chevron.
// Click the header to open the detail (ToolDetail). A card read off the screen has no status and no detail to show:
// only the note that its output is not read.
import { useState } from 'react';
import type { ToolStep } from '../../lib/sessionChatModel';
import '../../styles/chat-agent-cards.css';
import '../../styles/cockpit-chat-activity.css';
import { Chevron, CheckIcon, CrossIcon, KindIcon, PendingMark, SpinMark } from './chatCardIcons';
import { kindOfCall } from './chatActivity';
import { useStepFindsOpen } from './chatFind';
import { ToolDetail } from './ToolDetail';

export const STATUS_LABEL: Record<ToolStep['status'], string> = {
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
};

/** What a card shows: a call with no result in a turn that has ended never finished, so it is pending, not running. */
export type CardState = 'pending' | 'running' | 'done' | 'failed';

export function cardState(status: ToolStep['status'], live: boolean): CardState {
  if (status === 'error') return 'failed';
  if (status === 'ok') return 'done';
  return live ? 'running' : 'pending';
}

const BADGE_LABEL: Record<CardState, string> = {
  pending: 'Pending',
  running: STATUS_LABEL.running,
  done: STATUS_LABEL.ok,
  failed: STATUS_LABEL.error,
};

export function StatusBadge({ state }: { state: CardState }) {
  return (
    <span className={`ck-agc-badge ck-agc-badge--${state} ck-chat-tool-status${state === 'failed' ? ' ck-chat-tool-status--error' : ''}`} data-state={state} aria-live="polite">
      {state === 'running' && <SpinMark />}
      {state === 'pending' && <PendingMark />}
      {state === 'done' && <CheckIcon />}
      {state === 'failed' && <CrossIcon />}
      <span className={state === 'running' ? 'ck-agc-shim' : undefined}>{BADGE_LABEL[state]}</span>
    </span>
  );
}

export interface ToolRowProps {
  step: ToolStep;
  /** The row is read off the terminal's screen: no name, no status, no detail. */
  fromScreen: boolean;
  /** Start open (Verbose). A click then closes or opens it. */
  defaultOpen?: boolean;
  /** The turn has no end yet. Off, a call with no result shows as pending. Default on. */
  live?: boolean;
}

export function ToolRow({ step, fromScreen, defaultOpen = false, live = true }: ToolRowProps) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  // Find in this chat: a row whose detail holds the match opens by itself.
  const foundHere = useStepFindsOpen(step);
  const open = toggled ?? (defaultOpen || foundHere);
  const { call, status } = step;
  const state = cardState(status, live);
  return (
    <div className={`ck-chat-row ck-agc-card${fromScreen ? '' : ` ck-agc-card--${state}`}`}>
      <button type="button" aria-expanded={open} onClick={() => setToggled(!open)} className="ck-chat-tool ck-agc-head">
        <span className="ck-agc-ico">
          <KindIcon kind={kindOfCall(call)} />
        </span>
        <span className="ck-agc-title">
          {call.name && <b className="ck-agc-name ck-chat-tool-name">{call.name}</b>}
          <span className="ck-agc-sub ck-chat-tool-summary" title={call.summary}>
            {call.summary}
          </span>
        </span>
        {!fromScreen && <StatusBadge state={state} />}
        <Chevron />
      </button>
      {open && (
        <div className="ck-agc-body">
          {fromScreen ? <p className="ck-agc-note">Tool output is not read from the screen.</p> : <ToolDetail step={step} failed={status === 'error'} />}
        </div>
      )}
    </div>
  );
}
