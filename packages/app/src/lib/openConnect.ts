// The Connect page: three tabs (Devices, Team, Lending). Cards, links and old Settings rows send people there
// through `openConnect`. The cockpit registers how (its view + tab); the separate Settings window (Individual mode)
// has no cockpit view; there Connect is one page of that window, drawn by SettingsPanel.
export const CONNECT_TABS = ['devices', 'team', 'lending'] as const;
export type ConnectTab = (typeof CONNECT_TABS)[number];
/** The two tabs that were folded into Devices: callers (and a remembered tab) may still say them. */
export type LegacyConnectTab = 'phone' | 'pcs';

/** Any tab name, old or new, as one of the three. Unknown names fall back to Devices. */
export function normalizeConnectTab(tab: string | null | undefined): ConnectTab {
  if (tab === 'team' || tab === 'lending') return tab;
  return 'devices';
}

const LAST_TAB_KEY = 'pm.connect.tab';

/** The tab used last (Connect reopens on it). Devices when nothing is remembered. */
export function rememberedConnectTab(): ConnectTab {
  try {
    return normalizeConnectTab(window.localStorage.getItem(LAST_TAB_KEY));
  } catch {
    return 'devices';
  }
}

export function rememberConnectTab(tab: ConnectTab): void {
  try {
    window.localStorage.setItem(LAST_TAB_KEY, tab);
  } catch {
    /* a private window: the tab is just not remembered */
  }
}

let registered: ((tab: ConnectTab) => void) | null = null;

/** The cockpit registers how to show the Connect page on a tab. Pass null to unregister. */
export function registerConnectOpener(open: ((tab: ConnectTab) => void) | null): void {
  registered = open;
}

/** True while the cockpit's Connect page can be opened (not in the separate Settings window). */
export function connectPageAvailable(): boolean {
  return registered !== null;
}

/** Show the Connect page on `tab`. Does nothing when there is no cockpit to show it. */
export function openConnect(tab: ConnectTab | LegacyConnectTab = 'devices'): void {
  registered?.(normalizeConnectTab(tab));
}

/** Settings page and row names that now live on a Connect tab (old deep links keep working). */
const TARGETS: Record<string, ConnectTab> = {
  connect: 'devices',
  phone: 'devices',
  mobile: 'devices',
  pairing: 'devices',
  'paired-devices': 'devices',
  devices: 'devices',
  'devices-page': 'devices',
  team: 'team',
  'team-page': 'team',
  lend: 'lending',
  'lend-page': 'lending',
};

/** The Connect tab an old Settings target (`phone`, `lend-page`, ...) stands for; undefined when it is not one of them. */
export function connectTabFor(target: string | null | undefined): ConnectTab | undefined {
  return target ? TARGETS[target] : undefined;
}
