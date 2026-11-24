// Connect: three tabs, one job each. Devices (my phone, my other PCs, can they reach this PC), Team (who is here, let
// people in) and Lending (lend my agent, borrow someone's). The screens inside are the ones Settings and the Team page
// always had (TeamHost, LendPage, RequestUsage): this file arranges them. Nothing is folded away: no "Advanced", no
// "More options". A tab that needs you gets a small amber dot. Switching tabs keeps each tab's scroll place and any
// half-done sheet (a visited tab stays mounted, hidden), and the app reopens Connect on the tab used last.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { PairedDeviceInfo, Settings } from '@potato-workspace/shared';
import { useT } from '../../i18n';
import { accountApi, type AccountApi } from '../../lib/account';
import { devicesApi, type DevicesApi } from '../../lib/devices';
import { isActiveIn, isActiveOut, lendApi, type LendApi } from '../../lib/lend';
import { CONNECT_TABS, rememberConnectTab, type ConnectTab } from '../../lib/openConnect';
import { loadSettings, patchSettings, type SettingsPatch } from '../../lib/settings';
import { tauri } from '../../lib/tauri';
import type { SshApi } from '../../lib/ssh';
import { teamApi, type TeamApi } from '../../lib/team';
import { useTeam, type TeamHandle } from '../cockpit/team/useTeam';
import { RequestUsage } from '../lend/RequestUsage';
import { useLend, type LendHandle } from '../lend/useLend';
import { LendPage } from '../settings/blocks/LendPage';
import { TeamHost } from '../team-page/TeamHost';
import { defaultTunnelApi } from '../PairingAddress';
import { DevicesTab } from './DevicesTab';
import { Embed } from './ConnectParts';
import type { PhoneApi } from './PhoneGroup';
import { ReachLine, useThisPc, type ThisPcHandle } from './ThisPc';
import '../../styles/settings.css';
import '../../styles/settings-rows.css';
import '../../styles/connect.css';
import '../../styles/connect-tabs.css';

import type { TunnelApi } from '../settings/TunnelSection';
import type { UpdateApi } from '../../lib/workerUpdate';
import type { WorkerHealth } from '../../lib/worker';

/** What the page reads and writes. Tests pass fakes; the app uses the defaults. */
export interface ConnectApi {
  loadSettings: () => Promise<Settings>;
  patchSettings: (patch: SettingsPatch) => Promise<Settings>;
  listPhones: () => Promise<PairedDeviceInfo[]>;
  /** What a phone's own sheet changes (rename, one switch, remove). */
  phoneApi?: PhoneApi;
  devices: DevicesApi;
  account: AccountApi;
  lend: LendApi;
  team: TeamApi;
  /** The link's commands (start, fix, check). Tests pass a fake; the app uses the real ones. */
  tunnel?: TunnelApi;
  /** The one-button setup's step commands. Tests pass fakes; the app uses the real ones. */
  updateApi?: UpdateApi;
  /** Asks the link what it can do (plain GETs). Tests pass a fake; the app asks the real one. */
  workerHealth?: (address: string) => Promise<WorkerHealth | null>;
  /** The SSH commands (Other computers). Tests pass a fake. */
  ssh?: SshApi;
}

const DEFAULT_API: ConnectApi = {
  loadSettings,
  patchSettings,
  listPhones: () => tauri.listPairedMobileDevices(),
  devices: devicesApi,
  account: accountApi,
  lend: lendApi,
  team: teamApi,
};

export interface ConnectPageProps {
  tab: ConnectTab;
  onTab: (tab: ConnectTab) => void;
  /** The cockpit shares its own team and lend state, so nothing is read twice. */
  team?: TeamHandle;
  lend?: LendHandle;
  paneNames?: Map<string, string>;
  displayName?: string;
  /**
   * "Open" on one of my PCs: show that PC's section in the sidebar (unfold it and scroll to it). The cockpit passes this
   * once the sidebar has those sections; without it Connect shows that PC's own page inside the Devices tab.
   */
  onOpenPc?: (node: string) => boolean | void;
  /** A terminal was opened on an SSH computer: the cockpit shows that pane. */
  onOpenPane?: (paneId: string) => void;
  api?: Partial<ConnectApi>;
}

const TAB_KEY = { devices: 'connect.tab.devices', team: 'connect.tab.team', lending: 'connect.tab.lending' } as const;

export function ConnectPage({ tab, onTab, team, lend, paneNames, displayName, onOpenPc, onOpenPane, api: apiIn }: ConnectPageProps) {
  const t = useT();
  // Held in a ref-like memo keyed on the parts, so a new `api` object each render does not restart the reads.
  const apiRef = useRef(apiIn);
  apiRef.current = apiIn;
  const api = useMemo<ConnectApi>(() => ({ ...DEFAULT_API, ...apiRef.current }), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pageRef = useRef<HTMLDivElement>(null);
  const scrolls = useRef<Record<string, number>>({});
  const lastTab = useRef<ConnectTab>(tab);
  // A tab is built the first time it is shown and then kept (hidden), so a half-done sheet survives a switch.
  const [visited, setVisited] = useState<ReadonlySet<ConnectTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));

  useEffect(() => {
    let alive = true;
    api
      .loadSettings()
      .then((s) => alive && setSettings(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  const patch = useCallback(
    async (p: SettingsPatch) => {
      const saved = await api.patchSettings(p);
      setSettings(saved);
    },
    [api],
  );

  // Each tab keeps its own scroll place: the page that scrolls is the nearest scrolling parent.
  useLayoutEffect(() => {
    const el = (pageRef.current?.closest('.ck-connect-scroll') as HTMLElement | null) ?? null;
    if (lastTab.current !== tab) {
      scrolls.current[lastTab.current] = el?.scrollTop ?? 0;
      lastTab.current = tab;
      if (el) el.scrollTop = scrolls.current[tab] ?? 0;
    }
    rememberConnectTab(tab);
  }, [tab]);

  const pc = useThisPc({ tunnel: api.tunnel ?? defaultTunnelApi, updateApi: api.updateApi, pcsOn: settings?.far_pcs_enabled !== false, healthApi: api.workerHealth });
  const ownTeam = useTeam(api.team, !team);
  const ownLend = useLend(api.lend);
  const lendHandle = lend ?? ownLend;
  const dots = useAttention(api.team, lendHandle, pc);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CONNECT_TABS.length) % CONNECT_TABS.length;
    onTab(CONNECT_TABS[next]!);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="cx-shell" data-testid="connect-page" ref={pageRef}>
      <h1 className="cx-sr">{t('connect.title')}</h1>
      <div className="cx-tabsbar">
        <div className="cx-seg" role="tablist" aria-label={t('connect.tabs.aria')}>
          {CONNECT_TABS.map((id, i) => (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`connect-tab-${id}`}
              data-testid={`connect-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`connect-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => onTab(id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t(TAB_KEY[id])}
              {dots[id] && <span className="cx-tdot" data-testid={`connect-dot-${id}`} role="img" aria-label={t('connect.tab.needsYou')} />}
            </button>
          ))}
        </div>
      </div>
      {CONNECT_TABS.map((id) =>
        visited.has(id) ? (
          <div key={id} className="cx-panel" role="tabpanel" id={`connect-panel-${id}`} aria-labelledby={`connect-tab-${id}`} data-testid={`connect-panel-${id}`} hidden={tab !== id}>
            {id === 'devices' && <DevicesTab api={api} settings={settings} patch={patch} pc={pc} active={tab === id} onOpenPc={onOpenPc} onOpenPane={onOpenPane} lend={lendHandle} />}
            {id === 'team' && (
              <div className="cx-page">
                <ReachLine pc={pc} />
                <Embed>
                  <TeamHost api={api.team} lendClient={api.lend} team={team ?? ownTeam} lend={lendHandle} paneNames={paneNames} displayName={displayName} />
                </Embed>
              </div>
            )}
            {id === 'lending' && <LendingTab api={api} lend={lendHandle} settings={settings} patch={patch} pc={pc} />}
          </div>
        ) : null,
      )}
    </div>
  );
}

/** Which tabs need the person: this PC cannot be reached (Devices), someone waits to join (Team), someone asks to borrow (Lending). */
function useAttention(teamClient: TeamApi, lend: LendHandle, pc: ThisPcHandle): Record<ConnectTab, boolean> {
  const [joins, setJoins] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void Promise.resolve()
        .then(() => teamClient.configGet())
        .then((c) => alive && setJoins(c.admin === true && Array.isArray(c.joins) && c.joins.length > 0))
        .catch(() => undefined);
    load();
    let off: (() => void) | undefined;
    teamClient
      .onChanged(load)
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => undefined);
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      off?.();
      window.clearInterval(timer);
    };
  }, [teamClient]);
  const asked = lend.state ? lend.state.requests_in.some((r) => r.state === 'open') : false;
  return { devices: pc.state === 'broken', team: joins, lending: asked };
}

// ---------- Lending ----------

function LendingTab({ api, lend, settings, patch, pc }: { api: ConnectApi; lend: LendHandle; settings: Settings | null; patch: (p: SettingsPatch) => Promise<void>; pc: ThisPcHandle }) {
  const t = useT();
  // The switch shows what the person chose at once, and the saved setting after that. (It used to also wait for the lend
  // state, which only catches up on its 15 s poll: turning off looked stuck on, and a second click turned it back on.)
  const [choice, setChoice] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const on = choice ?? (settings ? settings.lend_enabled === true : lend.enabled);
  const flip = async (next: boolean) => {
    setChoice(next);
    setFailed(false);
    try {
      await patch({ lend_enabled: next });
      lend.refresh();
    } catch {
      setFailed(true);
    } finally {
      setChoice(null);
    }
  };
  const state = lend.state;
  const out = state ? state.grants.filter((g) => isActiveOut(g, lend.now)).length : 0;
  const incoming = state ? state.grants.filter((g) => isActiveIn(g, lend.now)).length : 0;
  return (
    <div className="cx-page">
      <ReachLine pc={pc} />
      <section className="cx-group cx-first" data-testid="connect-lending-top">
        <div className="cx-switchrow cx-switchrow--top">
          <div>
            <b>{t('connect.lending.switch')}</b>
            {failed && (
              <div className="cx-note" role="alert" data-testid="connect-lending-switch-error">
                {t('connect.lending.switchFailed')}
              </div>
            )}
            <div className="cx-note" data-testid="connect-status-lending">
              {!on ? t('connect.lending.offLine') : out + incoming > 0 ? t('connect.lending.status', { out, in: incoming }) : t('connect.lending.none')}
            </div>
          </div>
          <label className="cx-switch">
            <input type="checkbox" role="switch" checked={on} disabled={settings === null || choice !== null} aria-label={t('connect.lending.switch')} data-testid="connect-lending-switch" onChange={(e) => void flip(e.target.checked)} />
            <span aria-hidden="true" />
          </label>
        </div>
      </section>
      {/* Borrowing needs no setup, so Ask to borrow shows with the switch off too. */}
      <div className="cx-actions" data-testid="connect-main-lending">
        <RequestUsage api={api.lend} team={api.team} devices={api.devices} lend={lend} variant="settings" />
      </div>
      {on && (
        <Embed>
          <LendPage api={api.lend} team={api.team} />
        </Embed>
      )}
    </div>
  );
}
