// One list of the words the app shows people. Copy files and components take their wording from here,
// and glossary.test.ts fails when a banned word shows up in rendered text. Add a term here first.
//
//  agent        what does the work (Claude, Codex, ...). "helper" is only a sub-agent that an agent
//               started; Simple mode and the welcome say "agent" for both.
//  sign in      one phrase for getting into an agent: never login, account, Accounts or Logins.
//  chat         the readable way to run an agent; "terminal" is the raw screen. Never "ACP".
//  inbox        where agents that need you wait.
//  receipt      the record of what an agent did.

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

/** Sign-in wording, for every place a login or an account used to be named. */
export const SIGN_IN = {
  /** Button on a row that needs it. */
  action: 'Sign in',
  /** Status of an agent that is installed but signed out. */
  needed: 'Needs sign in',
  /** The Settings group (was "Logins"). */
  group: 'Sign in',
  /** The Settings row (was "Accounts"). */
  rowLabel: 'Sign in',
  rowHint: 'Sign in to the same agent more than once, and pick one per pane.',
  rowKeywords: 'sign in login account profile work personal add remove switch',
  /** Add another way to sign in (was "Add account" / "Add another login"). */
  addAnother: 'Add another sign-in',
  /** Open the agent's own sign-in window (was "Open login pane"). */
  openWindow: 'Open sign-in window',
  /** On a usage-limit card: start the same agent under another way to sign in. */
  useAnother: 'Use another sign-in',
  /** The noun inside a sentence ("Change sign-in"). */
  noun: 'sign-in',
  /** The sign-in used when none is picked (was "Default login"). */
  defaultOne: 'Default sign-in',
} as const;

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
