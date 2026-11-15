// An agent's "ask the person a multiple-choice question" tool call (OpenCode's `question`, Claude's AskUserQuestion).
// An ACP adapter shows it as an ordinary tool call whose input holds the questions; there is no way to answer it
// through the protocol, so the chat draws a card with the options and sends the choice back as a message. Pure.
import type { ToolCallItem } from '../../lib/sessionChatModel';

export interface AskOption {
  label: string;
  description: string | null;
}

export interface AskQuestion {
  header: string | null;
  question: string;
  options: AskOption[];
  multiple: boolean;
}

const NAMES = new Set(['question', 'askuserquestion', 'ask_user_question', 'ask_question']);
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 12;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function optionOf(raw: unknown): AskOption | null {
  const plain = text(raw);
  if (plain) return { label: plain, description: null };
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const label = text(r.label) ?? text(r.value) ?? text(r.title);
  return label ? { label, description: text(r.description) } : null;
}

function questionOf(raw: unknown): AskQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const question = text(r.question) ?? text(r.prompt);
  if (!question || !Array.isArray(r.options)) return null;
  const options = r.options.map(optionOf).filter((o): o is AskOption => o !== null).slice(0, MAX_OPTIONS);
  if (options.length === 0) return null;
  return { header: text(r.header), question, options, multiple: r.multiple === true || r.multiSelect === true };
}

/** The questions of a tool call that asks the person something, or null when the call is not one. */
export function questionsOfCall(call: Pick<ToolCallItem, 'name' | 'input'>): AskQuestion[] | null {
  if (!NAMES.has((call.name ?? '').trim().toLowerCase())) return null;
  const input = call.input as { questions?: unknown } | null | undefined;
  if (!input || typeof input !== 'object') return null;
  const list = Array.isArray(input.questions) ? input.questions : [input];
  const questions = list.slice(0, MAX_QUESTIONS).map(questionOf).filter((q): q is AskQuestion => q !== null);
  return questions.length > 0 ? questions : null;
}

/** The message that carries the person's choice back to the agent. */
export function answerText(question: AskQuestion, picked: readonly string[]): string {
  return `My answer to "${question.question}": ${picked.join(', ')}`;
}
