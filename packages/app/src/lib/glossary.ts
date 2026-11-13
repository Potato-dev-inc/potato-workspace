// One list of the words the app shows people. Copy files and components take their wording from here,
// and glossary.test.ts fails when a banned word shows up in rendered text. Add a term here first.
//
//  agent        what does the work (Claude, Codex, ...). "helper" is only a sub-agent that an agent
//               started; Simple mode and the welcome say "agent" for both.
//  sign in      one phrase for getting into an agent: never login, account, Accounts or Logins.
//  chat         the readable way to run an agent; "terminal" is the raw screen. Never "ACP".
//  inbox        where agents that need you wait.
//  receipt      the record of what an agent did.

import { t } from '../i18n';

export const TERMS = {
  agent: 'agent',
  agents: 'agents',
  helper: 'helper',
  signIn: 'Sign in',
  inbox: 'Inbox',
  receipt: 'Receipt',
  chat: 'Chat',
  terminal: 'Terminal',
} as const;

/**
 * Sign-in wording, for every place a login or an account used to be named. The texts people read are getters, so they
 * follow the language when they are read; `rowKeywords` is search text and stays as it is.
 */
export const SIGN_IN = {
  /** Button on a row that needs it. */
  get action() {
    return t('risk.signIn.action');
  },
  /** Status of an agent that is installed but signed out. */
  get needed() {
    return t('risk.signIn.needed');
  },
  /** The Settings group (was "Logins"). */
  get group() {
    return t('risk.signIn.group');
  },
  /** The Settings row (was "Accounts"). */
  get rowLabel() {
    return t('risk.signIn.rowLabel');
  },
  get rowHint() {
    return t('risk.signIn.rowHint');
  },
  rowKeywords: 'sign in login account profile work personal add remove switch',
  /** Add another way to sign in (was "Add account" / "Add another login"). */
  get addAnother() {
    return t('risk.signIn.addAnother');
  },
  /** Open the agent's own sign-in window (was "Open login pane"). */
  get openWindow() {
    return t('risk.signIn.openWindow');
  },
  /** On a usage-limit card: start the same agent under another way to sign in. */
  get useAnother() {
    return t('risk.signIn.useAnother');
  },
  /** The noun inside a sentence ("Change sign-in"). */
  get noun() {
    return t('risk.signIn.noun');
  },
  /** The sign-in used when none is picked (was "Default login"). */
  get defaultOne() {
    return t('risk.signIn.defaultOne');
  },
};

/** Names of the two ways to run an agent. */
export const RUN_WAYS = {
  chat: 'Chat',
  chatTerminal: 'Chat (terminal)',
  terminal: 'Terminal',
  registryName: 'official agent registry',
} as const;

/** Words nobody should read in the app, and what to say. The glossary test scans rendered text for these. */
export const BANNED_TERMS: { pattern: RegExp; use: string; where: 'everywhere' | 'agent-screens' }[] = [
  // "login" and "account" are fine for GitHub or Cloudflare; the test checks them only on screens about agents.
  { pattern: /\blogins?\b/i, use: SIGN_IN.action, where: 'agent-screens' },
  { pattern: /\baccounts?\b/i, use: SIGN_IN.action, where: 'agent-screens' },
  { pattern: /\bACP\b/, use: RUN_WAYS.chat, where: 'everywhere' },
  { pattern: /\bAgent Client Protocol\b/i, use: RUN_WAYS.chat, where: 'everywhere' },
  { pattern: /Puppet Master/, use: 'Potato Workspace', where: 'everywhere' },
];

/**
 * One thing, one name. Each group lists the different words that were used for the same thing; a screen
 * that shows two of them calls one thing by two names. `use` is the name to keep. The screen scan
 * (scripts/roam.mjs) reports a screen that shows more than one variant of a group.
 */
export interface SynonymVariant {
  /** The label as people read it, for messages. */
  label: string;
  pattern: RegExp;
  /** Screens (harness scenario names) where this variant is meant to be used, so it is not counted there. */
  exceptScreens?: RegExp;
}
export interface SynonymGroup {
  concept: string;
  /** The label to keep. Must be one of the variants. */
  use: string;
  variants: SynonymVariant[];
}

export const SYNONYMS: SynonymGroup[] = [
  {
    concept: 'give another person use of one of your agents',
    use: 'Lend',
    variants: [
      { label: 'Lend', pattern: /\bLend(ing)?\b/ },
      { label: 'Share an agent', pattern: /\bShare an agent\b/i },
    ],
  },
  {
    concept: 'close a card without acting on it',
    use: 'Dismiss',
    variants: [
      { label: 'Dismiss', pattern: /\bDismiss\b/ },
      { label: 'Discard', pattern: /\bDiscard\b/ },
    ],
  },
  {
    concept: 'start a new agent',
    use: 'New agent',
    variants: [
      { label: 'New agent', pattern: /\bNew agent\b/i },
      // Simple mode has its own wording for the same action.
      { label: 'Make something', pattern: /\bMake something\b/i, exceptScreens: /^simple-/ },
    ],
  },
];

/** Groups with more than one variant present in `texts` (the text of one screen). `screen` is the scenario name. */
export function findSynonymClashes(texts: string[], screen = ''): { concept: string; use: string; found: string[] }[] {
  const clashes: { concept: string; use: string; found: string[] }[] = [];
  for (const group of SYNONYMS) {
    const found = group.variants
      .filter((v) => !(v.exceptScreens && v.exceptScreens.test(screen)))
      .filter((v) => texts.some((t) => v.pattern.test(t)))
      .map((v) => v.label);
    if (found.length > 1) clashes.push({ concept: group.concept, use: group.use, found });
  }
  return clashes;
}
