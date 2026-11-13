// The five Overview cards as plain data. Each function turns what a source answered into one status glyph, one line,
// one quiet sub-line and the actions. Pure, so the words are easy to test. A card never shows a tick without data:
// when its source fails (or has not answered) the card shows "…" and "Can't check this yet".
import { accountsFor, type AccountsOverview } from '../../lib/accounts';
import type { UpdateOffer } from '../../lib/app-update';
import type { HelperVisibility } from '../../lib/agentRunMode';
import { CANT_CHECK_YET, type CheckRow } from '../../lib/setup-checks';
import { problemWords } from './problem-words';

export type CardId = 'agents' | 'signed-in' | 'phone' | 'updates' | 'helpers';
export type Glyph = '✓' | '!' | '×' | '…' | '•';

/** What a card's button does. `fix` runs the first failing setup check's own fix; the others jump. */
export type CardAction =
  | { label: string; kind: 'row'; row: string; primary?: boolean }
  | { label: string; kind: 'page'; page: 'helpers'; primary?: boolean }
  | { label: string; kind: 'fix'; primary?: boolean };

export interface CardView {
  id: CardId;
  name: string;
  glyph: Glyph;
  line: string;
  sub?: string;
  actions: CardAction[];
}

export const CARD_NAMES: Record<CardId, string> = {
  agents: 'Agents',
  'signed-in': 'Signed in',
  phone: 'Phone',
  updates: 'Updates',
  helpers: 'Helpers',
};

/** A card whose source has not answered yet. */
export function loadingCard(id: CardId): CardView {
  return { id, name: CARD_NAMES[id], glyph: '…', line: 'Checking…', actions: [] };
}

/** A card whose source failed. Never a tick. */
export function cantCheckCard(id: CardId, why?: string): CardView {
  return { id, name: CARD_NAMES[id], glyph: '…', line: CANT_CHECK_YET, sub: why, actions: [] };
}

function join(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------- Agents ----------

/**
 * From the rows of "Check my setup" (the same rows the Setup list draws): a cross is "a fix", a "!" is "to check".
 * The sub-line is the worst row first, so the card and the list start with the same sentence.
 */
export function agentsCard(rows: CheckRow[]): CardView {
  const unreadable = rows.some((r) => r.id === 'agents' && r.sentence === CANT_CHECK_YET);
  if (unreadable) return cantCheckCard('agents');
  const agentRows = rows.filter((r) => r.id.startsWith('agent-'));
  const ready = agentRows.filter((r) => r.status === 'ok').length;
  const problems = [...rows.filter((r) => r.status === 'fail'), ...rows.filter((r) => r.status === 'warn')];
  const check: CardAction = { label: 'Check my setup', kind: 'row', row: 'setup-check' };
  if (agentRows.length === 0) {
    return { id: 'agents', name: CARD_NAMES.agents, glyph: '!', line: 'No agent found on this computer', sub: 'Install one, then check again.', actions: [{ ...check, primary: true }] };
  }
  if (problems.length === 0) {
    return { id: 'agents', name: CARD_NAMES.agents, glyph: '✓', line: `${plural(ready, 'agent', 'agents')} ready`, actions: [check] };
  }
  const first = problems[0];
  const worst = first.status === 'fail' ? '×' : '!';
  return {
    id: 'agents',
    name: CARD_NAMES.agents,
    glyph: worst,
    line: problemWords(rows) ?? '',
    sub: first.sentence,
    actions: first.fix ? [{ label: first.fix.label, kind: 'fix', primary: true }, check] : [{ ...check, primary: true }],
  };
}

// ---------- Signed in ----------

function titleCase(agentId: string): string {
  const spaced = agentId.replace(/[-_]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Who is signed in comes from the setup checks when they know the agent (the same rows the Setup list draws), and
 * from the sign-in list only for an agent the checks do not cover. So this card can never say "signed in" about an
 * agent the Setup list says needs a sign-in or is not tested yet.
 */
export function signedInCard(overview: AccountsOverview, rows: CheckRow[]): CardView {
  const own = overview.accounts.filter((a) => !a.lend_only && !a.borrowed);
  const ids = overview.agents.map((a) => a.agent_id);
  const signInAction: CardAction = { label: 'Sign in', kind: 'row', row: 'accounts', primary: true };
  if (ids.length === 0) {
    return { id: 'signed-in', name: CARD_NAMES['signed-in'], glyph: '!', line: 'No agent to sign in yet', actions: [signInAction] };
  }
  const rowOf = (id: string) => rows.find((r) => r.id === `agent-${id}`);
  const state = (id: string): 'yes' | 'no' | 'unknown' => {
    const row = rowOf(id);
    if (!row) return accountsFor(own, id).length > 0 ? 'yes' : 'no';
    if (row.status === 'ok') return 'yes';
    return row.fix?.kind === 'signin' ? 'no' : 'unknown';
  };
  const withSignIn = ids.filter((id) => state(id) === 'yes');
  const without = ids.filter((id) => state(id) === 'no');
  const unknown = ids.filter((id) => state(id) === 'unknown');
  const many = withSignIn.find((id) => accountsFor(own, id).length > 1);
  const sub = many ? `${accountsFor(own, many).length} sign-ins for ${titleCase(many)}.` : undefined;
  if (without.length > 0) {
    const names = without.map(titleCase);
    return {
      id: 'signed-in',
      name: CARD_NAMES['signed-in'],
      glyph: '!',
      line: `${join(names)} ${names.length === 1 ? 'is' : 'are'} not signed in`,
      sub,
      actions: [signInAction],
    };
  }
  if (unknown.length > 0) {
    const names = unknown.map(titleCase);
    return {
      id: 'signed-in',
      name: CARD_NAMES['signed-in'],
      glyph: '!',
      line: `${join(names)} ${names.length === 1 ? 'is' : 'are'} not checked yet`,
      sub,
      actions: [{ label: 'Check my setup', kind: 'row', row: 'setup-check', primary: true }],
    };
  }
  return {
    id: 'signed-in',
    name: CARD_NAMES['signed-in'],
    glyph: '✓',
    line: `${join(withSignIn.map(titleCase))} ${withSignIn.length === 1 ? 'is' : 'are'} signed in`,
    sub,
    actions: [{ label: 'Manage', kind: 'row', row: 'accounts' }],
  };
}

// ---------- Phone ----------

export function phoneCard(paired: number): CardView {
  if (paired === 0) {
    return {
      id: 'phone',
      name: CARD_NAMES.phone,
      glyph: '•',
      line: 'No phone yet',
      sub: 'Watch and answer your agents from your phone.',
      actions: [{ label: 'Pair a phone', kind: 'row', row: 'pairing', primary: true }],
    };
  }
  return {
    id: 'phone',
    name: CARD_NAMES.phone,
    glyph: '✓',
    line: `${plural(paired, 'phone', 'phones')} paired`,
    actions: [{ label: 'Your phones', kind: 'row', row: 'paired-devices' }],
  };
}

// ---------- Updates ----------

export function updatesCard(version: string | null, offer: UpdateOffer | null): CardView {
  const shown = version ? version.replace(/^v/i, '') : null;
  if (offer) {
    return {
      id: 'updates',
      name: CARD_NAMES.updates,
      glyph: '!',
      line: `${offer.version} is ready`,
      sub: shown ? `You have ${shown}.` : undefined,
      actions: [
        { label: 'Update', kind: 'row', row: 'version', primary: true },
        { label: "What's new", kind: 'row', row: 'whats-new' },
      ],
    };
  }
  if (!shown) return cantCheckCard('updates');
  return {
    id: 'updates',
    name: CARD_NAMES.updates,
    glyph: '✓',
    line: `Up to date (${shown})`,
    actions: [{ label: "What's new", kind: 'row', row: 'whats-new' }],
  };
}

// ---------- Helpers ----------

export interface HelpersFacts {
  mode: HelperVisibility;
  keepOpen: boolean;
  /** Potato Workspace is in at least one installed agent's settings, so agents can ask each other for help. */
  connected: boolean;
}

export function helpersCard(facts: HelpersFacts): CardView {
  if (!facts.connected) {
    return {
      id: 'helpers',
      name: CARD_NAMES.helpers,
      glyph: '!',
      line: "Agents can't ask each other for help yet",
      sub: 'Connect your agents once, and review what is written first.',
      actions: [{ label: 'Connect', kind: 'row', row: 'agent-pack', primary: true }],
    };
  }
  const line =
    facts.mode === 'always_background'
      ? 'Helpers run in the background'
      : facts.mode === 'agent_chooses'
        ? 'The agent chooses where helpers show'
        : facts.keepOpen
          ? 'Helpers show in a pane and stay open'
          : 'Helpers show in a pane and close when done';
  return { id: 'helpers', name: CARD_NAMES.helpers, glyph: '✓', line, actions: [{ label: 'Change', kind: 'page', page: 'helpers' }] };
}
