// The Overview page's five cards: Agents, Signed in, Phone, Updates, Helpers. Each card loads on its own, so one
// slow source never blocks the others, and shows "…" with "Can't check this yet" when its source fails.
// The Agents and Signed in cards read the SAME setup rows as the Setup list under them (setup-source.tsx), so the
// cards and the list never disagree. Cards that need a fix come first. The rows under the cards are ordinary rows.
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@potato-workspace/shared';
import { tauriAccountsApi, type AccountsOverview } from '../../lib/accounts';
import { tauriHelperAgentsApi, type HelperVisibility } from '../../lib/agentRunMode';
import { agentPackApi } from '../../lib/agent-pack';
import { tauriUpdateTransport, type UpdateOffer } from '../../lib/app-update';
import { DEV_LABS_KEYS } from '../../lib/dev-labs';
import { runAllChecks, tauriSetupDeps, type CheckRow, type SetupCheckContext, type SetupCheckDeps } from '../../lib/setup-checks';
import { SetupChecksProvider, useSharedSetupChecks, type SetupChecksState } from './setup-source';
import { tauri } from '../../lib/tauri';
import { errorSentence } from '../../lib/sayError';
import { Btn } from './settings-ui';
import { DEFAULT_SETUP_ACTIONS, runFix, type SetupCheckActions } from './SetupCheckPage';
import {
  agentsCard,
  cantCheckCard,
  helpersCard,
  loadingCard,
  phoneCard,
  signedInCard,
  updatesCard,
  type CardAction,
  type CardId,
  type CardView,
  type HelpersFacts,
} from './overview-model';

/** Where each Overview card gets its facts. The app uses the defaults; tests pass fakes. */
export interface OverviewSources {
  checks: (deps: SetupCheckDeps, ctx: SetupCheckContext) => Promise<CheckRow[]>;
  setupDeps: SetupCheckDeps;
  accounts: () => Promise<AccountsOverview>;
  phones: () => Promise<number>;
  version: () => Promise<string | null>;
  update: () => Promise<UpdateOffer | null>;
  helpers: () => Promise<HelpersFacts>;
  actions: SetupCheckActions;
}

export const DEFAULT_OVERVIEW_SOURCES: OverviewSources = {
  checks: (deps, ctx) => runAllChecks(deps, ctx),
  setupDeps: tauriSetupDeps,
  accounts: () => tauriAccountsApi.list(),
  phones: async () => (await tauri.listPairedMobileDevices()).filter((d) => !d.expired).length,
  version: async () => (await tauri.getAppInstallInfo()).version,
  update: () => tauriUpdateTransport.check(),
  helpers: async () => {
    const [mode, keep, pack] = await Promise.all([tauriHelperAgentsApi.get(), tauriHelperAgentsApi.getKeepOpen(), agentPackApi.preview()]);
    return {
      mode: mode.mode as HelperVisibility,
      keepOpen: keep.on,
      connected: pack.agents.some((a) => a.installed && a.mcp?.status === 'unchanged'),
    };
  },
  actions: DEFAULT_SETUP_ACTIONS,
};

type Loaded<T> = { state: 'loading' } | { state: 'failed'; why: string } | { state: 'ready'; value: T };

/** Runs `load` once on mount. A rejection becomes `failed`; nothing here throws. */
function useSource<T>(load: () => Promise<T>): Loaded<T> {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    loadRef
      .current()
      .then((value) => alive && setResult({ state: 'ready', value }))
      .catch((error) => alive && setResult({ state: 'failed', why: errorSentence(error) }));
    return () => {
      alive = false;
    };
  }, []);
  return result;
}

/** Turns a source's answer into a card; "loading" and "failed" never show a tick. */
function cardOf<T>(id: CardId, source: Loaded<T>, view: (value: T) => CardView, why = false): CardView {
  if (source.state === 'loading') return loadingCard(id);
  if (source.state === 'failed') return cantCheckCard(id, why ? source.why : undefined);
  return view(source.value);
}

export interface OverviewProps {
  settings: Settings;
  bridgeUrl: string | null;
  /** Jump to a row (the panel's `openRow`). */
  openRow: (rowId: string) => void;
  /** Jump to a page. */
  openPage: (page: 'helpers') => void;
  sources?: OverviewSources;
}

/** What the setup checks need to know from the Settings window. */
export function setupContext(settings: Settings, bridgeUrl: string | null): SetupCheckContext {
  return { bridgeUrl, labs: Object.fromEntries(DEV_LABS_KEYS.map((k) => [k, settings[k]])) };
}

/** Cards with the ones that need a fix first (a cross, then a "!"); equal cards keep their order. */
const URGENCY: Record<string, number> = { '×': 0, '!': 1 };
export function fixFirst(cards: CardView[]): CardView[] {
  return [...cards].sort((a, b) => (URGENCY[a.glyph] ?? 2) - (URGENCY[b.glyph] ?? 2));
}

export function Overview(props: OverviewProps) {
  const { settings, bridgeUrl, sources = DEFAULT_OVERVIEW_SOURCES } = props;
  const shared = useSharedSetupChecks();
  // Under the Settings window the provider is already there, and the Setup list reads it too. Alone (a test), the
  // cards bring their own.
  if (shared) return <OverviewCards {...props} />;
  return (
    <SetupChecksProvider run={() => sources.checks(sources.setupDeps, setupContext(settings, bridgeUrl))} actions={sources.actions}>
      <OverviewCards {...props} />
    </SetupChecksProvider>
  );
}

function OverviewCards({ openRow, openPage, sources = DEFAULT_OVERVIEW_SOURCES }: OverviewProps) {
  const checks: SetupChecksState = useSharedSetupChecks()?.result ?? { state: 'loading' };
  const accounts = useSource(sources.accounts);
  const phones = useSource(sources.phones);
  const version = useSource(sources.version);
  const update = useSource(sources.update);
  const helpers = useSource(sources.helpers);
  const refreshChecks = useSharedSetupChecks()?.refresh ?? (() => undefined);
  const [fixError, setFixError] = useState<string | null>(null);

  const updatesView = (): CardView => {
    // Both sources are needed for a tick: the version we run, and the answer of the update check.
    if (version.state === 'loading' || update.state === 'loading') return loadingCard('updates');
    if (update.state === 'failed') return cantCheckCard('updates', update.why);
    return updatesCard(version.state === 'ready' ? version.value : null, update.value);
  };

  const signedInView = (): CardView => {
    // The checks and the sign-in list are both needed: the checks decide who is signed in.
    if (accounts.state === 'failed') return cantCheckCard('signed-in');
    if (checks.state === 'failed') return cantCheckCard('signed-in');
    if (accounts.state === 'loading' || checks.state === 'loading') return loadingCard('signed-in');
    return signedInCard(accounts.value, checks.rows);
  };

  const cards: CardView[] = fixFirst([
    checks.state === 'ready' ? agentsCard(checks.rows) : checks.state === 'failed' ? cantCheckCard('agents') : loadingCard('agents'),
    signedInView(),
    cardOf('phone', phones, phoneCard),
    updatesView(),
    cardOf('helpers', helpers, helpersCard),
  ]);

  const run = (action: CardAction) => {
    if (action.kind === 'row') return openRow(action.row);
    if (action.kind === 'page') return openPage(action.page);
    // Fix: the first failing check's own fix button.
    const first = checks.state === 'ready' ? [...checks.rows.filter((r) => r.status === 'fail'), ...checks.rows.filter((r) => r.status === 'warn')].find((r) => r.fix) : undefined;
    if (!first?.fix) return openRow('setup-check');
    setFixError(null);
    void Promise.resolve(runFix(first.fix, sources.actions)).then(() => refreshChecks()).catch((error) => setFixError(errorSentence(error)));
  };

  return (
    <div className="st-cards" data-testid="overview-cards">
      {cards.map((card) => (
        <section key={card.id} className="st-card" data-card={card.id} data-tone={card.glyph === '×' || card.glyph === '!' ? 'fix' : undefined} aria-label={card.name}>
          <div className="st-card-top">
            <span className="st-glyph" aria-hidden="true">
              {card.glyph}
            </span>
            <span>{card.name}</span>
          </div>
          <p className="st-card-line">{card.line}</p>
          {card.sub && <p className="st-card-sub">{card.sub}</p>}
          {card.id === 'agents' && fixError && (
            <p className="st-card-sub" role="alert">
              {fixError}
            </p>
          )}
          {card.actions.length > 0 && (
            <div className="st-card-act">
              {card.actions.map((action) => (
                <Btn key={action.label} primary={action.primary} small onClick={() => run(action)}>
                  {action.label}
                </Btn>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
