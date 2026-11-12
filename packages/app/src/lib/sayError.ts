// One place that turns anything a screen catches (an Error, a string, a backend `{ code, message }`, nothing at
// all) into a sentence a person can read. The raw text goes in `details` for a Details area or a log, never
// in `text` when it looks like a programmer's message ("Cannot read properties of null", "[object Object]").

export const GENERIC_ERROR = 'Something went wrong. Try again.';

export interface SaidError {
  /** The plain sentence to show. */
  text: string;
  /** The raw text for a Details area or the log. May be empty. */
  details: string;
}

/** Backend codes that have a plain sentence. A code not listed here shows the backend's own sentence. */
const CODE_SENTENCES: Readonly<Record<string, string>> = {
  WORKSPACE_TRUST_DECLINED: 'You chose not to trust this folder, so nothing was sent.',
  AGENT_EXITED: 'The agent closed unexpectedly. Your files are as it left them.',
  AGENT_NOT_INSTALLED: 'That agent is not installed on this PC yet.',
  PANE_NOT_READY: 'The agent was not ready, so nothing was typed.',
  PROMPT_NOT_SUBMITTED: 'The task was typed, but the agent did not start on it.',
};

/** Things only a programmer should read: JS engine messages, stack lines, serialised objects. */
const TECHNICAL = [
  /cannot (read|set|destructure) propert/i,
  /\bis not (a function|defined|iterable|a constructor)\b/i,
  /\bundefined is not\b/i,
  /\b(null|undefined) (is not|has no)\b/i,
  /\[object \w+\]/,
  /^(Type|Reference|Range|Syntax|Eval|URI)Error\b/,
  /\bUnexpected (token|end of JSON|identifier)/i,
  /^\s*at\s.+\(.*:\d+:\d+\)/m,
  /\bTauri command unavailable\b/i,
  /\bfailed to fetch\b/i,
  /\bload failed\b/i,
  /\bNetworkError\b/i,
];

const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,}):\s*/;
const TYPE_PREFIX = /^(Error|Uncaught Error):\s*/i;
const MAX_LEN = 280;

function rawOf(e: unknown): { raw: string; code: string | null } {
  if (typeof e === 'string') return { raw: e, code: null };
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return { raw: e.message, code: typeof code === 'string' ? code : null };
  }
  if (e && typeof e === 'object') {
    const o = e as { message?: unknown; error?: unknown; code?: unknown; reason?: unknown };
    const code = typeof o.code === 'string' ? o.code : null;
    for (const v of [o.message, o.error, o.reason]) {
      if (typeof v === 'string') return { raw: v, code };
      if (v && typeof v === 'object') return rawOf(v);
    }
    return { raw: '', code };
  }
  return { raw: '', code: null };
}

/**
 * The sentence for a caught value. `where` names the part of the app ("saving the key"); it only goes into
 * `details`. `fallback` replaces the generic sentence when the screen knows better ("Could not send the message.").
 */
export function sayError(e: unknown, where = '', fallback: string = GENERIC_ERROR): SaidError {
  const { raw, code: ownCode } = rawOf(e);
  const prefixed = CODE_PREFIX.exec(raw.trim());
  const code = ownCode ?? prefixed?.[1] ?? null;
  const cleaned = raw.trim().replace(CODE_PREFIX, '').replace(TYPE_PREFIX, '').trim();
  const details = [where && `Where: ${where}`, code && `Code: ${code}`, raw.trim() && `Message: ${raw.trim()}`].filter(Boolean).join('\n');

  if (code && CODE_SENTENCES[code]) return { text: CODE_SENTENCES[code], details };
  if (!cleaned || cleaned.length > MAX_LEN || cleaned.includes('\n') || TECHNICAL.some((re) => re.test(cleaned))) {
    return { text: fallback, details };
  }
  return { text: cleaned, details };
}

/** Just the sentence, for the many places that only show one line. */
export const errorSentence = (e: unknown, fallback?: string): string => sayError(e, '', fallback).text;

/** The backend code on a caught value (`{ code }` or a `CODE: message` text), or null. */
export function errorCode(e: unknown): string | null {
  const { raw, code } = rawOf(e);
  return code ?? CODE_PREFIX.exec(raw.trim())?.[1] ?? null;
}
