// The five Overview cards as plain data. Each function turns what a source answered into one status glyph, one line,
// one quiet sub-line and the actions. Pure, so the words are easy to test. A card never shows a tick without data:
// when its source fails (or has not answered) the card shows "…" and "Can't check this yet".
import { accountsFor, type AccountsOverview } from '../../lib/accounts';
import { checkFailureLine, type CheckFailure, type UpdateOffer } from '../../lib/app-update';
import type { HelperVisibility } from '../../lib/agentRunMode';
import { t } from '../../i18n';
import { isCantCheck, type CheckRow } from '../../lib/setup-checks';
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

/** The card names, read when a card is built so the language switch shows. */
export const CARD_NAMES: Record<CardId, string> = {
  get agents() {
    return t('settings.card.agents');
  },
  get 'signed-in'() {
    return t('settings.card.signed-in');
  },
  get phone() {
    return t('settings.card.phone');
  },
  get updates() {
    return t('settings.card.updates');
  },
  get helpers() {
    return t('settings.card.helpers');
  },
};

/** A card whose source has not answered yet. */
export function loadingCard(id: CardId): CardView {
  return { id, name: CARD_NAMES[id], glyph: '…', line: t('settings.card.checking'), actions: [] };
}

/** A card whose source failed. Never a tick. */
export function cantCheckCard(id: CardId, why?: string): CardView {
  return { id, name: CARD_NAMES[id], glyph: '…', line: t('settings.card.cantCheck'), sub: why, actions: [] };
}

function join(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return t('settings.card.and', { list: names.slice(0, -1).join(t('settings.card.listSep')), last: names[names.length - 1] });
}

// ---------- Agents ----------

/**
 * From the rows of "Check my setup" (the same rows the Setup list draws): a cross is "a fix", a "!" is "to check".
 * The sub-line is the worst row first, so the card and the list start with the same sentence.
 */
export function agentsCard(rows: CheckRow[]): CardView {
  const unreadable = rows.some((r) => r.id === 'agents' && isCantCheck(r.sentence));
  if (unreadable) return cantCheckCard('agents');
  const agentRows = rows.filter((r) => r.id.startsWith('agent-'));
  const ready = agentRows.filter((r) => r.status === 'ok').length;
  const problems = [...rows.filter((r) => r.status === 'fail'), ...rows.filter((r) => r.status === 'warn')];
  const check: CardAction = { label: t('settings.checkSetup'), kind: 'row', row: 'setup-check' };
  if (agentRows.length === 0) {
    return { id: 'agents', name: CARD_NAMES.agents, glyph: '!', line: t('settings.card.noAgent'), sub: t('settings.card.noAgentSub'), actions: [{ ...check, primary: true }] };
  }
  if (problems.length === 0) {
    return { id: 'agents', name: CARD_NAMES.agents, glyph: '✓', line: t('settings.card.agentsReady', { count: ready }), actions: [check] };
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
  const signInAction: CardAction = { label: t('settings.signIn'), kind: 'row', row: 'accounts', primary: true };
  if (ids.length === 0) {
    return { id: 'signed-in', name: CARD_NAMES['signed-in'], glyph: '!', line: t('settings.card.noAgentToSignIn'), actions: [signInAction] };
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
  const sub = many ? t('settings.card.signIns', { count: accountsFor(own, many).length, name: titleCase(many) }) : undefined;
  if (without.length > 0) {
    const names = without.map(titleCase);
    return {
      id: 'signed-in',
      name: CARD_NAMES['signed-in'],
      glyph: '!',
      line: t('settings.card.notSignedIn', { count: names.length, names: join(names) }),
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
      line: t('settings.card.notChecked', { count: names.length, names: join(names) }),
      sub,
      actions: [{ label: t('settings.checkSetup'), kind: 'row', row: 'setup-check', primary: true }],
    };
  }
  return {
    id: 'signed-in',
    name: CARD_NAMES['signed-in'],
    glyph: '✓',
    line: t('settings.card.signedIn', { count: withSignIn.length, names: join(withSignIn.map(titleCase)) }),
    sub,
    actions: [{ label: t('settings.card.manage'), kind: 'row', row: 'accounts' }],
  };
}

// ---------- Phone ----------

export function phoneCard(paired: number): CardView {
  if (paired === 0) {
    return {
      id: 'phone',
      name: CARD_NAMES.phone,
      glyph: '•',
      line: t('settings.card.noPhone'),
      sub: t('settings.card.noPhoneSub'),
      actions: [{ label: t('settings.card.pairPhone'), kind: 'row', row: 'pairing', primary: true }],
    };
  }
  return {
    id: 'phone',
    name: CARD_NAMES.phone,
    glyph: '✓',
    line: t('settings.card.phonesPaired', { count: paired }),
    actions: [{ label: t('settings.card.yourPhones'), kind: 'row', row: 'paired-devices' }],
  };
}

// ---------- Updates ----------

/** A check that could not read a channel: one plain line, never "Up to date". */
export function checkFailedCard(failure: CheckFailure): CardView {
  return { id: 'updates', name: CARD_NAMES.updates, glyph: '…', line: checkFailureLine(failure), actions: [{ label: t('settings.card.whatsNew'), kind: 'row', row: 'whats-new' }] };
}

export function updatesCard(version: string | null, offer: UpdateOffer | null): CardView {
  const shown = version ? version.replace(/^v/i, '') : null;
  if (offer) {
    return {
      id: 'updates',
      name: CARD_NAMES.updates,
      glyph: '!',
      line: t('settings.card.updateReady', { version: offer.version }),
      sub: shown ? t('settings.card.youHave', { version: shown }) : undefined,
      actions: [
        { label: t('settings.card.update'), kind: 'row', row: 'version', primary: true },
        { label: t('settings.card.whatsNew'), kind: 'row', row: 'whats-new' },
      ],
    };
  }
  if (!shown) return cantCheckCard('updates');
  return {
    id: 'updates',
    name: CARD_NAMES.updates,
    glyph: '✓',
    line: t('settings.card.upToDate', { version: shown }),
    actions: [{ label: t('settings.card.whatsNew'), kind: 'row', row: 'whats-new' }],
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
      line: t('settings.card.helpersNone'),
      sub: t('settings.card.helpersNoneSub'),
      actions: [{ label: t('settings.card.connect'), kind: 'row', row: 'agent-pack', primary: true }],
    };
  }
  const line =
    facts.mode === 'always_background'
      ? t('settings.card.helpersBackground')
      : facts.mode === 'agent_chooses'
        ? t('settings.card.helpersChoose')
        : facts.keepOpen
          ? t('settings.card.helpersOpen')
          : t('settings.card.helpersClose');
  return { id: 'helpers', name: CARD_NAMES.helpers, glyph: '✓', line, actions: [{ label: t('settings.card.change'), kind: 'page', page: 'helpers' }] };
}
