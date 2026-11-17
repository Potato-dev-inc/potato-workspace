// "Using workflow: <name>": the first message of a chat that the app itself started from a workflow is the brief
// (what the agent is told about its helpers and rules) and then the person's own request. The agent gets that text
// unchanged. Only the screen folds the brief into one card. The start path records (per chat, on this PC) that the
// chat began as a workflow and the exact brief; the view splits the first message only when that record exists AND the
// message really begins with that brief. A person who types the same words in a normal chat sees plain text.

/** The line between the brief and the person's request (the same text as `first_message` in crews/workflow.rs). */
export const REQUEST_SEPARATOR = "\nThe person's request:\n";

export const LS_WORKFLOW_STARTS = 'pm.workflowStarts';
const MAX_STARTS = 200;

export interface WorkflowStart {
  name: string;
  /** The brief as the plan made it, without the request. */
  brief: string;
}

export interface WorkflowSplit {
  name: string;
  brief: string;
  /** The person's own message (may be empty). */
  request: string;
}

/** The text the agent receives: the brief, then the request. Mirrors Rust `first_message`. */
export function workflowFirstMessage(brief: string, request: string): string {
  return `${brief.trimEnd()}${REQUEST_SEPARATOR}${request.trim()}`;
}

function readAll(): Record<string, WorkflowStart> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_WORKFLOW_STARTS) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, WorkflowStart> = {};
    for (const [pane, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as Partial<WorkflowStart> | null;
      if (v && typeof v.name === 'string' && typeof v.brief === 'string' && v.brief.trim() !== '') out[pane] = { name: v.name, brief: v.brief };
    }
    return out;
  } catch {
    return {};
  }
}

/** Remembers that this chat began as a workflow. The newest 200 are kept. Never throws. */
export function recordWorkflowStart(paneId: string, start: WorkflowStart): void {
  try {
    if (start.brief.trim() === '') return;
    const all = readAll();
    delete all[paneId];
    all[paneId] = { name: start.name, brief: start.brief };
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_STARTS))) delete all[old];
    localStorage.setItem(LS_WORKFLOW_STARTS, JSON.stringify(all));
  } catch {
    /* storage can be blocked: the chat then shows the plain text */
  }
}

export function readWorkflowStart(paneId: string | null | undefined): WorkflowStart | null {
  return paneId ? (readAll()[paneId] ?? null) : null;
}

/** Splits the first user message of a workflow chat; null (show it as it is) when it does not begin with the recorded brief. */
export function splitWorkflowMessage(text: string, start: WorkflowStart | null): WorkflowSplit | null {
  if (!start) return null;
  const prefix = `${start.brief.trimEnd()}${REQUEST_SEPARATOR}`;
  if (!text.startsWith(prefix)) return null;
  return { name: start.name, brief: start.brief.trimEnd(), request: text.slice(prefix.length) };
}
