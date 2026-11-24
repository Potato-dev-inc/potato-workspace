// Questions an agent asks the human through the `ask_user` MCP tool (see docs/features/ask-user.md).
// Shape mirrors the Rust `questions::Question` (snake_case, as served by the bridge).

import { t } from '../i18n';

export interface QuestionChoice {
  id: string;
  label: string;
}

/** What a consent card is about (Rust `questions::ConsentInfo`). Only Potato Workspace raises these. */
export interface ConsentInfo {
  action: 'take_over' | 'answer_prompt' | 'config_change' | 'background_command';
  /** Who is asking, as a name ("Claude", "Another agent"). */
  requester: string;
  /** What it wants to control, as a name ("Codex"). The card prefers the pane's own name. */
  target: string;
  pane_id?: string;
  /** For `answer_prompt`: how risky the prompt is. */
  risk?: 'medium' | 'high';
}

/**
 * What a usage-limit card is about (Rust `questions::LimitInfo`). Only Potato Workspace raises these, when an
 * agent ran out of usage (`usage_limit`) or when a reminder the person asked for comes due (`reset_reminder`).
 */
export interface LimitInfo {
  kind: 'usage_limit' | 'reset_reminder';
  /** The agent's name in the words the card uses ("Claude"). */
  agent_label: string;
  /** What ran out ("session limit"), when the screen said. */
  window?: string;
  /** When it can continue (epoch ms), when the screen printed a time this computer could read. */
  reset_at_ms?: number;
  /** The time as the screen printed it. */
  reset_text?: string;
  /** The agent will carry on by itself at the reset. */
  self_resume_armed?: boolean;
  /** A run is bound to the pane, so "Stop here" has something to stop. */
  has_run?: boolean;
}

export interface Question {
  id: string;
  asker?: string;
  /** Name the agent gave itself. */
  agent?: string;
  pane_id?: string;
  question: string;
  choices: QuestionChoice[];
  allow_free_text: boolean;
  context?: string;
  urgency: 'normal' | 'high';
  created_at_ms: number;
  expires_at_ms: number;
  state: 'pending' | 'answered' | 'cancelled' | 'timed_out';
  /** Set when this is a consent card (an agent asking to control a pane it did not start). */
  consent?: ConsentInfo;
  /** `budget` for the pause card of a run that used its budget (only Potato Workspace raises one). */
  kind?: string;
  /** Set when this is a usage-limit card (an agent ran out of usage), not a question an agent asked. */
  limit?: LimitInfo;
}

/** The pause card of an agent that used its budget: "Add 10 turns" / "Stop here". */
export const isBudget = (q: Question): boolean => q.kind === 'budget';

/** A consent card, not a question an agent asked. */
export const isConsent = (q: Question): boolean => q.consent !== undefined;

/** A usage-limit card (or the reminder for one), not a question an agent asked. */
export const isLimit = (q: Question): boolean => q.limit !== undefined;

/** "Start on #42 with Codex?": the card that asks before an agent starts on a GitHub issue. */
export const isIssueStart = (q: Question): boolean => q.kind === 'issue_start';

/** "Draft PR ready for #42?": the card that asks before a branch is pushed and a draft PR is opened. */
export const isIssuePush = (q: Question): boolean => q.kind === 'issue_push';

/** Either issue card (Assign an issue). These are raised by Potato Workspace only and answered by the person only. */
export const isIssueCard = (q: Question): boolean => isIssueStart(q) || isIssuePush(q);

/** "CI failed on #61 (lint, test). Ask Codex to fix it?": the card that asks before an agent reads a failed CI log. */
export const isCiFix = (q: Question): boolean => q.kind === 'ci_fix';

/** "Push the fix to #61?": the card that asks before a CI fix is pushed. */
export const isCiPush = (q: Question): boolean => q.kind === 'ci_push';

/** Either Red to Green card. Raised by Potato Workspace only and answered by the person only. */
export const isCiCard = (q: Question): boolean => isCiFix(q) || isCiPush(q);

/** What the person typed or picked: exactly one of the two. */
export type QuestionAnswer = { choice_id: string } | { text: string };

/** "Question from Claude": the agent's own name, else the pane's name, else "an agent". */
export function askerName(q: Question, paneName?: string): string {
  return q.agent?.trim() || paneName || t('risk.ask.anAgent');
}

/** A tool permission an agent asked for (kind acp_permission): the app writes it as "<Agent> asks permission: <Write notes.txt>"; this reads it back as who and what, or null for any other question. */
export function permissionAsk(q: Question): { who: string; action: string } | null {
  if (q.kind !== 'acp_permission') return null;
  const m = /^(.*?) asks permission: ([\s\S]+)$/.exec(q.question);
  return m ? { who: m[1].trim() || t('risk.ask.anAgent'), action: permissionWords(m[2].trim()) } : null;
}

const VERBS = ['Write', 'Edit', 'Run', 'Read', 'Delete', 'Move', 'Fetch', 'Search'] as const;
/** The agent's tool title in the person's language: "Write a.txt" starts with a translated verb (spaced from the file name), "mcp__server__ask_user" reads "use the ask_user tool". Anything else stays as the agent wrote it. */
export function permissionWords(title: string): string {
  const mcp = /^mcp__.+?__(\S+)$/.exec(title);
  if (mcp) return t('inboxCards.verb.mcp', { tool: mcp[1] });
  const verb = VERBS.find((v) => title === v || title.startsWith(`${v} `));
  if (!verb) return title;
  return `${t(`inboxCards.verb.${verb}`)} ${title.slice(verb.length).trim()}`.trim();
}

/** Pending and not past its deadline (the app expires them too; this hides a stale card sooner). */
export function isLive(q: Question, now: number): boolean {
  return q.state === 'pending' && q.expires_at_ms > now;
}

/** "8 min", "under a minute", "2 h": a short, rounded-up time left. */
export function timeLeftText(ms: number): string {
  if (ms <= 60_000) return t('risk.ask.underMinute');
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 90) return t('risk.ask.minutes', { n: minutes });
  return t('risk.ask.hours', { n: Math.round(minutes / 60) });
}

/** "Claude stops waiting in 8 min": how long the asking agent will still wait for an answer. */
export function waitCaption(q: Question, now: number, paneName?: string): string {
  const who = q.agent?.trim() || paneName || t('risk.ask.theAgent');
  const left = q.expires_at_ms - now;
  // Chinese text keeps no space after a Chinese name but one after a Latin one ("Claude 會在 8 分鐘後"): the strings have none, this adds it.
  const spaced = (s: string) => s.replace(/([A-Za-z0-9])([㐀-鿿])/g, '$1 $2');
  if (left <= 0) return spaced(t('risk.ask.stoppedWaiting', { who }));
  return spaced(t('risk.ask.stopsWaiting', { who, time: timeLeftText(left) }));
}

/** "Which login should this Claude helper use?": raised when an agent starts a helper and the person's choice is "Ask me". */
export const isHelperLogin = (q: Question): boolean => q.kind === 'helper_login';

export interface HelperLoginOption {
  /** `main` or an account id. */
  id: string;
  label: string;
}

/**
 * The logins a helper-login card offers. The card carries each login twice, as `once:<id>` and `always:<id>`
 * (so a phone or any other list of choices works unchanged); the desktop card shows each login once with an
 * "Always use this" box and answers with the right one.
 */
export function helperLoginOptions(q: Question): HelperLoginOption[] {
  return q.choices.filter((c) => c.id.startsWith('once:')).map((c) => ({ id: c.id.slice('once:'.length), label: c.label }));
}

/** The choice id for a pick: `once:<id>`, or `always:<id>` when the person ticked "Always use this". */
export function helperLoginChoice(id: string, always: boolean): string {
  return `${always ? 'always' : 'once'}:${id}`;
}
