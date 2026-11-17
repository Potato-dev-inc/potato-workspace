// "Set up my relay": the one-button guided setup. This file is the plain logic (no screen): what went wrong in plain
// words (from what wrangler printed), and a scrub for the "Show details" text. The steps themselves are the existing
// worker_update_step commands run by lib/workerUpdate.ts; nothing here shows a command or a secret.
import type { UpdateStepId } from './workerUpdate';

export type RelayProblem = 'accounts' | 'signin' | 'offline' | 'subdomain' | 'unverified' | 'install' | 'mismatch' | 'ratelimit' | 'linking' | 'other';

/** Which fix button a problem gets (the screen draws the label). */
export type RelayFix = 'retry' | 'cloudflare' | 'fresh';

export const PROBLEM_FIX: Record<RelayProblem, RelayFix> = {
  accounts: 'cloudflare',
  signin: 'retry',
  offline: 'retry',
  subdomain: 'cloudflare',
  unverified: 'cloudflare',
  install: 'retry',
  mismatch: 'fresh',
  ratelimit: 'retry',
  linking: 'retry',
  other: 'retry',
};

const OFFLINE = /could not reach|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network|internet|offline/i;
const SUBDOMAIN = /workers\.dev subdomain|subdomain|onboarding|register .*workers/i;
const UNVERIFIED = /verify.*email|email.*verif|not verified|unverified/i;
const ACCOUNTS = /more than one account/i;
const RATE = /rate.?limit|too many requests|\b429\b|\b971\b|slow down/i;
const SIGNIN =
  /not (logged|signed) in|not authenticated|authentication|unauthori[sz]ed|login (failed|cancel|timed)|authorization code|oauth|denied|cancel|sign in|signed in|\b10000\b|\b9106\b/i;

/** What an unfixable-by-waiting failure looks like: no point running the same step again three times. */
export function stopsRetrying(id: UpdateStepId, output: string): boolean {
  if (id === 'login') return SIGNIN.test(output);
  return SUBDOMAIN.test(output) || UNVERIFIED.test(output) || ACCOUNTS.test(output);
}

/** The plain problem for the step that failed and what it printed. */
export function classifyProblem(step: UpdateStepId | 'link', output: string): RelayProblem {
  // "An old relay is in the way" comes ONLY from the backend's own flag on the link step (see RelaySetup), never from
  // what the tool printed: its messages say "does not match" about many unrelated things.
  if (step === 'link') return 'linking';
  if (ACCOUNTS.test(output)) return 'accounts';
  if (UNVERIFIED.test(output)) return 'unverified';
  if (SUBDOMAIN.test(output)) return 'subdomain';
  if (RATE.test(output)) return 'ratelimit';
  if (OFFLINE.test(output)) return 'offline';
  if (step === 'login' || SIGNIN.test(output)) return 'signin';
  if (step === 'install') return 'install';
  return 'other';
}

/** Hides anything that looks like a key or token (long unbroken words) before it goes under "Show details". */
export function scrubDetails(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=]{28,}/g, '•••');
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ADDRESS = new RegExp('^https://(' + LABEL + ')\\.(' + LABEL + ')\\.workers\\.dev$');

/** `https://<name>.<you>.workers.dev` exactly (no path, no other host), lower case; null for anything else. With `name`: only that Worker. */
export function relayAddress(address: string | null | undefined, name?: string): string | null {
  const m = ADDRESS.exec((address ?? '').trim().toLowerCase().replace(/\/+$/, ''));
  if (!m || (name !== undefined && m[1] !== name.toLowerCase())) return null;
  return `https://${m[1]}.${m[2]}.workers.dev`;
}
