// Plain-language names for the transcript stream tags the backend writes (`agent_runs/transcript.rs`
// callers). The raw tags are internal; people read "Answer", not `assistant_final`.
import { t, type MessageKey } from '../i18n';

const LABELS: Record<string, MessageKey> = {
  user_task: 'state.stream.you',
  user_steer: 'state.stream.you',
  user: 'state.stream.you',
  assistant_final: 'state.stream.answer',
  agent: 'state.stream.agent',
  result: 'state.stream.result',
  success: 'state.stream.done',
  stdout: 'state.stream.output',
  stderr: 'state.stream.errors',
  permission: 'state.stream.approval',
  interrupted: 'state.stream.stopped',
  execution_failure: 'state.stream.failed',
  delivery: 'state.stream.sending',
  delivery_trace: 'state.stream.sendingDetails',
  diagnostic: 'state.stream.details',
  startup: 'state.stream.starting',
};

/** A short human label for a transcript stream tag; unknown tags become sentence case (`some_tag` -> "Some tag"). */
export function transcriptStreamLabel(stream: string): string {
  const known = LABELS[stream];
  if (known) return t(known);
  const text = stream.replace(/[_-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : t('state.stream.other');
}

/** Streams that carry what a person or the agent said; they read as prose. The rest is output and stays monospace. */
const PROSE = new Set(['user_task', 'user_steer', 'user', 'assistant_final', 'agent', 'result', 'success']);

export function isProseStream(stream: string): boolean {
  return PROSE.has(stream);
}

/** The speaker label of a transcript row: "You" and the agent's own name for its answers; other rows keep their plain label. */
export function transcriptSpeaker(stream: string, agentName: string): string {
  return stream === 'assistant_final' || stream === 'agent' ? agentName.trim() || transcriptStreamLabel(stream) : transcriptStreamLabel(stream);
}
