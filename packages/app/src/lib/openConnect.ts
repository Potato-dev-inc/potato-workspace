// The Connect page: one place for the phone, other PCs, the team and lending. Cards, links and old Settings
// rows send people there through `openConnect`. The cockpit registers how (its view + tab); the separate
// Settings window (Individual mode) has no cockpit view; there Connect is one page of that window, drawn by SettingsPanel.
export const CONNECT_TABS = ['phone', 'pcs', 'team', 'lending'] as const;
export type ConnectTab = (typeof CONNECT_TABS)[number];

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
export function openConnect(tab: ConnectTab = 'phone'): void {
  registered?.(tab);
}

/** Settings page and row names that now live on a Connect tab (old deep links keep working). */
const TARGETS: Record<string, ConnectTab> = {
  connect: 'phone',
  phone: 'phone',
  telegram: 'phone',
  mobile: 'phone',
  pairing: 'phone',
  tunnel: 'phone',
  'paired-devices': 'phone',
  'phone-notifications': 'phone',
  'revoke-all-devices': 'phone',
  devices: 'pcs',
  'devices-page': 'pcs',
  team: 'team',
  'team-page': 'team',
  lend: 'lending',
  'lend-page': 'lending',
};

/** The Connect tab an old Settings target (`phone`, `lend-page`, ...) stands for; undefined when it is not one of them. */
export function connectTabFor(target: string | null | undefined): ConnectTab | undefined {
  return target ? TARGETS[target] : undefined;
}
