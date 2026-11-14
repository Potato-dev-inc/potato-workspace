// Quick replies and saved prompts for the phone's message box (P17). When the agent has asked something, two or three chips
// are made from what it asked (yes or no, continue, run the tests). A chip only FILLS the box; Send sends. A "/" at the
// start of the box opens the saved prompts, which live on this phone only. Pure code apart from the storage helpers.

/** The kinds of chip, each with its own words in `phone.quick.<kind>`. */
export type QuickKind = 'yes' | 'no' | 'continue' | 'runTests' | 'explain';

const ASKS = /\?\s*$|[？]\s*$|\b(want me to|would you like|should i|shall i|do you want|ok to|okay to|ready to|proceed|go ahead|let me know)\b|(要不要|是否|可以嗎|好嗎|需要我|要我)/i;
const CONTINUE = /\b(continue|next step|step \d+ of \d+|move on|keep going)\b|繼續|下一步/i;
const TESTS = /\b(tests?|checks?|lint|build)\b|測試|檢查/i;
const MAX_CHIPS = 3;

// An open question ("What can I help you with?") has no yes or no answer: no chips for it.
const OPEN_QUESTION = /^\W*(what|which|how|where|when|who|whom|whose|why)\b|^\W*(什麼|哪|怎麼|如何|為什麼|為何)/i;

/** The last sentence of the text, without a trailing question mark's neighbours (a closing quote or bracket). */
function lastSentence(text: string): string {
  const parts = text.trim().split(/(?<=[.!?。！？])\s+|\n+/).filter((p) => p.trim() !== '');
  return parts[parts.length - 1] ?? '';
}

/** True when the agent's last words ask the person something that a chip can answer (a yes or no, a go-ahead). */
export function asksSomething(text: string | null): boolean {
  if (!text) return false;
  const tail = text.trim().slice(-400);
  if (!ASKS.test(tail)) return false;
  // The question itself decides: "What can I help you with today?" is open, "Want me to run the tests?" is not.
  return !OPEN_QUESTION.test(lastSentence(tail));
}

/**
 * The chips for what the agent asked, or none when it asked nothing. Two to three: `yes` and `no` for a question, with
 * `continue` and `runTests` when the words mention them.
 */
export function quickRepliesFor(asked: string | null): QuickKind[] {
  if (!asked || !asksSomething(asked)) return [];
  const tail = asked.trim().slice(-400);
  const chips: QuickKind[] = [];
  if (CONTINUE.test(tail)) chips.push('continue');
  chips.push('yes', 'no');
  if (TESTS.test(tail) && chips.length < MAX_CHIPS) chips.push('runTests');
  return chips.slice(0, MAX_CHIPS);
}

// ---- saved prompts (on this phone only) -------------------------------------------------------------------------------

export const SAVED_PROMPTS_KEY = 'pm.phone.savedPrompts';
export const MAX_SAVED_PROMPTS = 20;
export const MAX_SAVED_CHARS = 500;

/** The saved prompts, or null when the person never changed the list (the view then shows its starter prompts). */
export function readSavedPrompts(): string[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) ?? 'null') as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, MAX_SAVED_PROMPTS);
  } catch {
    return null;
  }
}

export function writeSavedPrompts(list: readonly string[]): void {
  try {
    localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(list.slice(0, MAX_SAVED_PROMPTS)));
  } catch {
    /* private mode: the list lasts until the page closes */
  }
}

/** The list with `text` added at the top (trimmed, cut, no duplicate). */
export function withPrompt(list: readonly string[], text: string): string[] {
  const clean = text.trim().slice(0, MAX_SAVED_CHARS);
  if (clean === '') return [...list];
  return [clean, ...list.filter((p) => p !== clean)].slice(0, MAX_SAVED_PROMPTS);
}

/** Whether the box text opens the saved prompts: it starts with "/" and has no space yet. Returns the filter after the slash, or null. */
export function slashFilter(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}
