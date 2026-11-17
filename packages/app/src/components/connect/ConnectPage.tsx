// Connect: the phone, other PCs, the team and lending on ONE page with four tabs. Each tab starts with what is
// connected, then one main button. The screens inside are the ones Settings, the Team page and the Devices page
// always had (PairedDevices, MobilePairingPanel, DevicesPage, TeamHost, LendPage, RequestUsage): this file only
// arranges them. "Sign-ins stay on their own device" is said once, at the top.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PairedDeviceInfo, Settings } from '@potato-workspace/shared';
import { useT } from '../../i18n';
import { accountApi, type AccountApi } from '../../lib/account';
import { devicesApi, type DevicesApi } from '../../lib/devices';
import { isActiveIn, isActiveOut, lendApi, type LendApi } from '../../lib/lend';
import { CONNECT_TABS, type ConnectTab } from '../../lib/openConnect';
import { parseDevServerPort } from '../../lib/public-bridge-url';
import { loadSettings, patchSettings, type SettingsPatch } from '../../lib/settings';
import { tauri } from '../../lib/tauri';
import { teamApi, type TeamApi } from '../../lib/team';
import { DEVICES_CHANGED_EVENT, MobilePairingPanel } from '../MobilePairingPanel';
import { useTeam, type TeamHandle } from '../cockpit/team/useTeam';
import { AccountPanel } from '../account/AccountPanel';
import { EmptyState } from '../common/EmptyState';
import { DevicesPage } from '../devices/DevicesPage';
import { useDevices } from '../devices/useDevices';
import { RequestUsage } from '../lend/RequestUsage';
import { useLend, type LendHandle } from '../lend/useLend';
import { PairedDevices } from '../settings/blocks/PairedDevices';
import { LendPage } from '../settings/blocks/LendPage';
import { ConfirmSheet } from '../settings/controls';
import type { ConfirmOptions, RowDef, SettingsEnv } from '../settings/model';
import { RowShell } from '../settings/SectionView';
import { phoneRowsOriginal } from '../settings/sections/PhoneSection';
import { TeamHost } from '../team-page/TeamHost';
import { defaultTunnelApi } from '../PairingAddress';
import { Advanced } from './Advanced';
import { SimplePhone } from './SimplePhone';
import { RelaySetupSheet } from './RelaySetup';
import { StableOffer } from './StableOffer';
import { useTunnelStatus } from './useTunnelStatus';
import { YourRelay } from './YourRelay';
import { markTeamOfferSeen, offerSnoozed, teamFirstOpenPain } from '../../lib/connect-offer';
import '../../styles/settings.css';
import '../../styles/settings-rows.css';
import '../../styles/connect.css';

import type { TunnelApi } from '../settings/TunnelSection';
import type { UpdateApi } from '../../lib/workerUpdate';

const TunnelSection = lazy(() => import('../settings/TunnelSection').then((m) => ({ default: m.TunnelSection })));

/** What the page reads and writes. Tests pass fakes; the app uses the defaults. */
export interface ConnectApi {
  loadSettings: () => Promise<Settings>;
  patchSettings: (patch: SettingsPatch) => Promise<Settings>;
  listPhones: () => Promise<PairedDeviceInfo[]>;
  devices: DevicesApi;
  account: AccountApi;
  lend: LendApi;
  team: TeamApi;
  /** The phone address screen's commands. Tests pass a fake; the app uses the real ones. */
  tunnel?: TunnelApi;
  /** The one-button relay setup's step commands. Tests pass fakes; the app uses the real ones. */
  updateApi?: UpdateApi;
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
  api?: Partial<ConnectApi>;
}

const TAB_KEY = {
  phone: 'connect.tab.phone',
  pcs: 'connect.tab.pcs',
  team: 'connect.tab.team',
  lending: 'connect.tab.lending',
} as const;

export function ConnectPage({ tab, onTab, team, lend, paneNames, displayName, api: apiIn }: ConnectPageProps) {
  const t = useT();
  // Held in a ref-like memo keyed on the parts, so a new `api` object each render does not restart the reads.
  const apiRef = useRef(apiIn);
  apiRef.current = apiIn;
  const api = useMemo<ConnectApi>(() => ({ ...DEFAULT_API, ...apiRef.current }), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirmAsk, setConfirmAsk] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

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
  const env = useMemo<SettingsEnv | null>(
    () =>
      settings
        ? {
            settings,
            patch,
            markSaved: () => undefined,
            setError: () => undefined,
            confirm: (options) => new Promise<boolean>((resolve) => setConfirmAsk({ options, resolve })),
            projectPath: null,
            bridgeUrl: null,
          }
        : null,
    [settings, patch],
  );

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + CONNECT_TABS.length) % CONNECT_TABS.length;
    onTab(CONNECT_TABS[next]!);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="cn-page" data-testid="connect-page">
      <h1 className="cn-title">{t('connect.title')}</h1>
      <p className="cn-lead">{t('connect.lead')}</p>
      <p className="cn-stay" data-testid="connect-stay">
        {t('connect.stay')}
      </p>
      <div className="cn-tabs" role="tablist" aria-label={t('connect.tabs.aria')}>
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
            className={`cn-tab${tab === id ? ' is-on' : ''}`}
            onClick={() => onTab(id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t(TAB_KEY[id])}
          </button>
        ))}
      </div>
      <div className="cn-panel" role="tabpanel" id={`connect-panel-${tab}`} aria-labelledby={`connect-tab-${tab}`} data-testid={`connect-panel-${tab}`}>
        {tab === 'phone' && <PhoneTab api={api} env={env} />}
        {tab === 'pcs' && <PcsTab api={api} settings={settings} patch={patch} />}
        {tab === 'team' && <TeamTab api={api} team={team} lend={lend} paneNames={paneNames} displayName={displayName} />}
        {tab === 'lending' && <LendingTab api={api} lend={lend} settings={settings} patch={patch} />}
      </div>
      {confirmAsk && (
        <ConfirmSheet
          title={confirmAsk.options.title}
          body={confirmAsk.options.body}
          confirmLabel={confirmAsk.options.confirmLabel}
          onConfirm={() => (confirmAsk.resolve(true), setConfirmAsk(null))}
          onCancel={() => (confirmAsk.resolve(false), setConfirmAsk(null))}
        />
      )}
    </div>
  );
}

/** The reused Settings screens carry their own `.settings`-scoped styles: this gives them that scope without the Settings window around them. */
function Embed({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="settings settings--embed cn-embed" data-testid={testId}>
      {children}
    </div>
  );
}

/** What is connected, in one line, with a dot that is lit when something is. */
function Status({ tab, line, on }: { tab: ConnectTab; line: string; on?: boolean }) {
  return (
    <p className="cn-status" data-testid={`connect-status-${tab}`} data-on={on ? 'true' : 'false'}>
      <span className="cn-dot" aria-hidden="true" />
      {line}
    </p>
  );
}

/** The one main button of a tab. */
function Main({ tab, children, onClick, expanded }: { tab: ConnectTab; children: ReactNode; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" className="ck-btn ck-btn--primary cn-main" data-testid={`connect-main-${tab}`} aria-expanded={expanded} onClick={onClick}>
      {children}
    </button>
  );
}

function rowOf(id: string): RowDef {
  return phoneRowsOriginal.find((r) => r.id === id)!;
}

// ---------- Phone ----------

function PhoneTab({ api, env }: { api: ConnectApi; env: SettingsEnv | null }) {
  const t = useT();
  const [phones, setPhones] = useState<PairedDeviceInfo[] | null>(null);
  const [pairing, setPairing] = useState(false);
  const [address, setAddress] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listPhones()
        .then((p) => alive && setPhones(p.filter((d) => !d.expired)))
        .catch(() => alive && setPhones([]));
    load();
    window.addEventListener(DEVICES_CHANGED_EVENT, load);
    // A phone that scans the code shows up by itself.
    const timer = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(DEVICES_CHANGED_EVENT, load);
    };
  }, [api]);
  const count = phones?.length ?? 0;
  return (
    <>
      <SimplePhone
        tunnel={api.tunnel ?? defaultTunnelApi}
        phones={phones === null ? null : count}
        publicPwaUrl={env?.settings.public_pwa_url ?? ''}
        devServerPort={env?.settings.dev_server_port}
        ready={env !== null}
        paused={pairing}
        updateApi={api.updateApi}
      />
      <Advanced testId="connect-advanced" lines={['tunnel', 'named', 'custom', 'relay', 'token', 'restart']}>
        <YourRelay tunnel={api.tunnel ?? defaultTunnelApi} team={api.team} updateApi={api.updateApi} />
      <Status tab="phone" on={count > 0} line={phones === null ? '…' : count > 0 ? t('connect.phone.count', { count }) : t('connect.phone.none')} />
      <div className="cn-actions">
        <Main tab="phone" expanded={pairing} onClick={() => setPairing((v) => !v)}>
          {t('connect.phone.pair')}
        </Main>
        <button type="button" className="ck-btn cn-second" data-testid="connect-address" aria-expanded={address} onClick={() => setAddress((v) => !v)}>
          {t('connect.phone.address')}
        </button>
      </div>
      {pairing && env && (
        <Embed testId="connect-pairing">
          <MobilePairingPanel
            publicPwaUrl={env.settings.public_pwa_url ?? ''}
            devServerPort={parseDevServerPort(env.settings.dev_server_port)}
            onPublicPwaUrlChange={(value) => env.patch({ public_pwa_url: value.trim() || null })}
            onDevServerPortChange={(port) => env.patch({ dev_server_port: port })}
          />
        </Embed>
      )}
      {address && (
        <Embed testId="connect-tunnel">
          <Suspense fallback={null}>
            <TunnelSection api={api.tunnel} openTunnelOn={env?.settings.opentunnel_stable_link === true} />
          </Suspense>
        </Embed>
      )}
      <Embed testId="connect-phones">
        <PairedDevices />
      </Embed>
      {env && (
        <div className="cn-more" data-testid="connect-phone-more">
          <h2 className="cn-h2">{t('connect.phone.moreTitle')}</h2>
          <Embed>
            <RowShell row={rowOf('phone-notifications')} env={env} />
            <RowShell row={rowOf('mobile-keyboard-resizes')} env={env} />
            <RowShell row={rowOf('mobile-input-visible')} env={env} />
            <RowShell row={rowOf('revoke-all-devices')} env={env} />
          </Embed>
        </div>
      )}
      {env && (
        <details className="cn-more" data-testid="connect-telegram">
          <summary className="cn-h2">{t('connect.phone.telegram')}</summary>
          <Embed>
            <RowShell row={rowOf('telegram')} env={env} />
          </Embed>
        </details>
      )}
      </Advanced>
    </>
  );
}

// ---------- My PCs ----------

function PcsTab({ api, settings, patch }: { api: ConnectApi; settings: Settings | null; patch: (p: SettingsPatch) => Promise<void> }) {
  const t = useT();
  const { view, enabled } = useDevices(api.devices);
  const off = settings !== null && settings.devices_enabled !== true && !enabled;
  // Potato account (Labs): the sign-in and "My devices" come first, whether or not PC pairing is on.
  const account = settings?.account_enabled === true ? <AccountPanel api={api.account} /> : null;
  if (off) {
    return (
      <>
        {account}
        <Status tab="pcs" line={t('connect.pcs.none')} />
        <EmptyState
          testId="connect-pcs-off"
          title={t('connect.pcs.offTitle')}
          line={t('connect.pcs.offLine')}
          action={{ label: t('connect.pcs.turnOn'), onClick: () => void patch({ devices_enabled: true }) }}
        />
      </>
    );
  }
  const devices = view?.devices ?? [];
  const online = devices.filter((d) => d.state === 'online').length;
  return (
    <>
      {account}
      <Status tab="pcs" on={devices.length > 0} line={view ? (devices.length > 0 ? t('connect.pcs.count', { count: devices.length, online }) : t('connect.pcs.none')) : '…'} />
      <Embed>
        <DevicesPage api={api.devices} variant="connect" />
      </Embed>
    </>
  );
}

// ---------- Team ----------

function TeamTab({ api, team, lend, paneNames, displayName }: { api: ConnectApi; team?: TeamHandle; lend?: LendHandle; paneNames?: Map<string, string>; displayName?: string }) {
  const t = useT();
  const own = useTeam(api.team, !team);
  const { state } = team ?? own;
  const others = state?.members.length ?? 0;
  const line = !state ? '…' : !state.active ? t('connect.team.none') : others > 0 ? t('connect.team.on', { count: others }) : t('connect.team.alone');
  const tunnel = api.tunnel ?? defaultTunnelApi;
  const [tunnelStatus, setTunnelStatus] = useTunnelStatus(tunnel, 5000);
  // Team opened for the first time (after a phone has worked): one quiet offer to keep the same link.
  const [pain] = useState(() => teamFirstOpenPain() && !offerSnoozed());
  const [gone, setGone] = useState(false);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    if (pain) markTeamOfferSeen();
  }, [pain]);
  const hasFixed = tunnelStatus?.mode === 'stable' && Boolean(tunnelStatus.stable);
  return (
    <>
      <Status tab="team" on={Boolean(state?.active)} line={line} />
      {pain && !gone && !hasFixed && tunnelStatus !== undefined && <StableOffer onSet={() => setSetup(true)} onGone={() => setGone(true)} />}
      {setup && <RelaySetupSheet api={tunnel} updateApi={api.updateApi} onStatus={setTunnelStatus} onClose={() => setSetup(false)} />}
      <TeamHost api={api.team} lendClient={api.lend} team={team} lend={lend} paneNames={paneNames} displayName={displayName} />
      <Advanced testId="connect-team-advanced" lines={['relay', 'token']}>
        <YourRelay tunnel={tunnel} team={api.team} updateApi={api.updateApi} />
      </Advanced>
    </>
  );
}

// ---------- Lending ----------

function LendingTab({ api, lend, settings, patch }: { api: ConnectApi; lend?: LendHandle; settings: Settings | null; patch: (p: SettingsPatch) => Promise<void> }) {
  const t = useT();
  const own = useLend(api.lend);
  const handle = lend ?? own;
  const state = handle.state;
  if (settings !== null && settings.lend_enabled !== true && !handle.enabled) {
    return (
      <>
        <Status tab="lending" line={t('connect.lending.none')} />
        <EmptyState
          testId="connect-lending-off"
          title={t('connect.lending.offTitle')}
          line={t('connect.lending.offLine')}
          action={{ label: t('connect.lending.turnOn'), onClick: () => void patch({ lend_enabled: true }) }}
        />
      </>
    );
  }
  const out = state ? state.grants.filter((g) => isActiveOut(g, handle.now)).length : 0;
  const incoming = state ? state.grants.filter((g) => isActiveIn(g, handle.now)).length : 0;
  return (
    <>
      <Status tab="lending" on={out + incoming > 0} line={!state ? '…' : out + incoming > 0 ? t('connect.lending.status', { out, in: incoming }) : t('connect.lending.none')} />
      <div className="cn-actions cn-actions--ask" data-testid="connect-main-lending">
        <RequestUsage api={api.lend} team={api.team} devices={api.devices} lend={handle} variant="settings" />
      </div>
      <Embed>
        <LendPage api={api.lend} team={api.team} />
      </Embed>
    </>
  );
}
