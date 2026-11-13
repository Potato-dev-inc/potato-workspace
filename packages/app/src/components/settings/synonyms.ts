// Search synonyms. Every group is a set of words and phrases that mean the same thing to a person: typing any
// one of them also finds rows that talk about the others. Groups are two-way. A synonym hit scores like a
// keyword hit (see `SYNONYM_SCORE` in model.ts). Extend this list; never shrink it.

/** Lower-case words of a text: letters and digits only, so "claude.md" is "claude" and "md". */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export interface SynonymGroup {
  terms: string[];
  /** Also means the destructive rows: any row marked `danger` matches. */
  danger?: boolean;
}

export const SYNONYM_GROUPS: SynonymGroup[] = [
  { terms: ['dark', 'light', 'night', 'colour', 'color', 'appearance', 'dark mode', 'light mode', 'theme'] },
  { terms: ['login', 'log in', 'account', 'signin', 'subscription', 'plan', 'sign in'] },
  { terms: ['api', 'token', 'secret', 'password', 'credential', 'key'] },
  { terms: ['notification', 'notify', 'alert', 'ping', 'buzz', 'discord', 'phone alerts', 'telegram'] },
  { terms: ['mobile', 'iphone', 'android', 'qr', 'scan', 'phone', 'pair'] },
  { terms: ['subagent', 'sub-agent', 'worker', 'delegate', 'background', 'helper'] },
  { terms: ['mcp', 'bridge', 'server', 'connector', 'plugin', 'tool', 'connections to other tools', 'toolbelt'] },
  { terms: ['llm', 'provider', 'model', 'opencode', 'openrouter', 'models', 'default model'] },
  { terms: ['beta', 'experimental', 'preview', 'labs', 'early', 'early features'] },
  { terms: ['update', 'upgrade', 'release', 'changelog', 'version', "what's new"] },
  { terms: ['startup', 'boot', 'autostart', 'start at sign-in'] },
  { terms: ['sleep', 'lock', 'awake', 'keep awake'] },
  { terms: ['hotkey', 'keybinding', 'keyboard', 'shortcut', 'shortcuts'] },
  { terms: ['undo', 'restore', 'history', 'backup', 'snapshot', 'checkpoints', 'settings recovery'] },
  { terms: ['cost', 'budget', 'limit', 'quota', 'usage', 'limits', 'usage bar', 'when an agent runs out of usage'] },
  { terms: ['wsl', 'ubuntu', 'linux', 'run agents in linux'] },
  { terms: ['delete', 'remove', 'uninstall', 'reset', 'clear'], danger: true },
  { terms: ['logs', 'debug', 'support', 'diagnostic', 'report', 'observability', 'diagnostic file', 'check my setup'] },
  { terms: ['marketplace', 'store', 'install agent', 'add agent', 'agents'] },
  { terms: ['rules', 'guardrails', 'permission', 'approve', 'safety', 'security', 'rules for all agents'] },
  { terms: ['automation', 'schedule', 'overnight', 'night shift'] },
];

interface IndexedGroup {
  group: SynonymGroup;
  terms: string[][];
}

const INDEX: IndexedGroup[] = SYNONYM_GROUPS.map((group) => ({ group, terms: group.terms.map(wordsOf) }));
const MAX_PHRASE = 3;

/** A typed word or phrase, and the other ways of saying it. */
export interface QueryUnit {
  /** What was typed (one word, or a phrase such as "sign in"). */
  words: string[];
  /** Other word lists that mean the same, from every group the typed words belong to. */
  alts: string[][];
  /** True when the typed words are in a group that also means the destructive rows. */
  danger: boolean;
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/** The groups that hold these exact words (also tried with the last word singular). */
function groupsFor(words: string[]): IndexedGroup[] {
  const tries = [words];
  const last = words[words.length - 1];
  if (singular(last) !== last) tries.push([...words.slice(0, -1), singular(last)]);
  return INDEX.filter((g) => g.terms.some((t) => tries.some((candidate) => sameWords(t, candidate))));
}

/**
 * Splits a typed query into units: the longest known phrase first ("sign in", "dark mode"), else one word.
 * Each unit carries the alternatives from its synonym groups.
 */
export function queryUnits(query: string): QueryUnit[] {
  const typed = wordsOf(query);
  const units: QueryUnit[] = [];
  let i = 0;
  while (i < typed.length) {
    let taken = 1;
    let groups: IndexedGroup[] = [];
    for (let len = Math.min(MAX_PHRASE, typed.length - i); len >= 1; len--) {
      const found = groupsFor(typed.slice(i, i + len));
      if (found.length > 0) {
        taken = len;
        groups = found;
        break;
      }
    }
    const own = typed.slice(i, i + taken);
    const alts: string[][] = [];
    for (const g of groups) for (const t of g.terms) if (!sameWords(t, own) && !alts.some((a) => sameWords(a, t))) alts.push(t);
    units.push({ words: own, alts, danger: groups.some((g) => g.group.danger) });
    i += taken;
  }
  return units;
}
