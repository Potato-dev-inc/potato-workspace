// Potato account (Labs `account_enabled`, off by default): sign in once in the browser, and every device you sign in on
// shows up on your other devices. The account is an address book: it holds who you are and your devices, never an
// agent sign-in, a key, a chat or a file. The Rust side (src-tauri/src/account) holds the session and the device key;
// this file is the typed command surface and the small rules the screen shares. The window never gets the session
// token, the ticket or the sign-in secret: only "signed in as X" and the device list.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface AccountInfo {
  id: string;
  display_name: string;
  provider: string;
}

export interface AccountView {
  /** The address of the account service is known. */
  configured: boolean;
  signed_in: boolean;
  /** A sign-in was started in the browser and has not come back yet. */
  waiting: boolean;
  /** The last thing that went wrong, as a plain sentence. */
  message: string | null;
  account: AccountInfo | null;
  device_id: string | null;
}

export interface AccountDevice {
  id: string;
  kind: 'pc' | 'phone';
  /** Untrusted text: a device chose it. Render as text only. */
  name: string;
  /** Unix seconds. */
  created_at: number;
  last_seen_at: number;
  online: boolean;
  revoked: boolean;
  not_me: boolean;
  is_this: boolean;
}

export interface DevicesReply {
  signed_in: boolean;
  devices: AccountDevice[];
}

export type RevokeAction = 'sign_out' | 'not_me';

/** What the screen reads and writes. Tests give fakes. */
export interface AccountApi {
  state: () => Promise<AccountView>;
  signIn: () => Promise<AccountView>;
  cancel: () => Promise<AccountView>;
  devices: () => Promise<DevicesReply>;
  revoke: (id: string, action: RevokeAction) => Promise<DevicesReply>;
  signOutHere: () => Promise<AccountView>;
  /** Called when the sign-in state changed (a sign-in finished in the browser). Returns the stop function. */
  onChanged: (cb: () => void) => Promise<UnlistenFn>;
}

export const ACCOUNT_CHANGED_EVENT = 'pm-account-changed';

export const accountApi: AccountApi = {
  state: () => invoke<AccountView>('account_state'),
  signIn: () => invoke<AccountView>('account_sign_in'),
  cancel: () => invoke<AccountView>('account_cancel_sign_in'),
  devices: () => invoke<DevicesReply>('account_devices'),
  revoke: (id, action) => invoke<DevicesReply>('account_revoke_device', { id, action }),
  signOutHere: () => invoke<AccountView>('account_sign_out_here'),
  onChanged: (cb) => listen(ACCOUNT_CHANGED_EVENT, () => cb()),
};

/** A new device shows the "Not me?" banner for 24 hours. */
export const NEW_DEVICE_SECS = 24 * 60 * 60;

/** The devices that signed in during the last 24 hours, other than this one, not yet signed out, and not already dismissed. */
export function newDevices(devices: AccountDevice[], nowSecs: number, dismissed: ReadonlySet<string>): AccountDevice[] {
  return devices.filter((d) => !d.is_this && !d.revoked && !dismissed.has(d.id) && nowSecs - d.created_at < NEW_DEVICE_SECS && d.created_at <= nowSecs + 60);
}

const DISMISSED_KEY = 'pm.account.dismissed-new-devices';

/** "It's me" is a per-viewer convenience: kept in this window's storage, and the screen works without it. */
export function readDismissed(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(-50) : []);
  } catch {
    return new Set();
  }
}

export function rememberDismissed(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    /* the banner just comes back next time */
  }
}
