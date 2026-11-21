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
  /** This computer keeps its key in a private file (Linux). */
  key_in_file?: boolean;
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

/**
 * What pressing Open on one of my other PCs would do.
 * - `new`: first time. The two PCs pair and both people pick the number on both screens.
 * - `online` / `away`: already paired; it answers or does not.
 * - `not_allowed`: paired, but that PC has not let this one run agents there.
 * - `allow_there`: that PC has not ticked "Let my other PCs open this PC".
 * - `conflict`: another entry of the account names the same PC; neither is offered.
 * - `lookalike`: another entry has the same name or one that looks the same; neither is offered.
 */
export type AccountPcStatus = 'new' | 'online' | 'away' | 'not_allowed' | 'allow_there' | 'conflict' | 'lookalike';

export interface AccountPc {
  id: string;
  /** From that PC's own signed statement. Untrusted text: render as text only. */
  name: string;
  status: AccountPcStatus;
  /** The account says it was seen in the last two minutes. */
  online: boolean;
  /** Unix seconds. */
  last_seen_at: number;
  created_at: number;
  /** Added to the account in the last 24 hours. */
  recent: boolean;
  /** Its PC-link id (64 hex) when it can be opened. */
  node: string | null;
}

export interface AccountPcsReply {
  available: boolean;
  signed_in: boolean;
  /** This PC lets its other PCs open it (the tick). */
  open_here: boolean;
  /** This PC told the account where it can be reached. */
  published: boolean;
  pcs: AccountPc[];
  message?: string | null;
  /** PCs this PC unpaired because the account said they were signed out (the account's word is unsigned): shown until dismissed. `name` is untrusted text. */
  removed?: { id: string; name: string }[];
}

export interface OpenedPc {
  paired: boolean;
  node: string;
  name: string;
  state: string;
}

/** What the screen reads and writes. Tests give fakes. */
export interface AccountApi {
  state: () => Promise<AccountView>;
  signIn: () => Promise<AccountView>;
  cancel: () => Promise<AccountView>;
  devices: () => Promise<DevicesReply>;
  revoke: (id: string, action: RevokeAction) => Promise<DevicesReply>;
  signOutHere: () => Promise<AccountView>;
  /** My other PCs on the account (statements checked), with what Open would do. Reads the account. */
  pcs?: () => Promise<AccountPcsReply>;
  /** Open one: the first time the two PCs pair (both people pick the number); later it only checks that it answers. */
  openPc?: (id: string) => Promise<OpenedPc>;
  /** The tick "Let my other PCs open this PC". Written only by the app window, into its own file (not a setting a phone or an agent can patch). */
  setOpenHere?: (on: boolean) => Promise<void>;
  /** Dismiss the note that a PC was removed. */
  dismissRemoved?: (id: string) => Promise<void>;
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
  pcs: () => invoke<AccountPcsReply>('devices_account_pcs'),
  openPc: (id) => invoke<OpenedPc>('devices_open_account_pc', { id }),
  setOpenHere: (on) => invoke<void>('devices_set_open_from_account', { on }),
  dismissRemoved: (id) => invoke<void>('devices_dismiss_removed_pc', { id }),
  onChanged: (cb) => listen(ACCOUNT_CHANGED_EVENT, () => cb()),
};

/** A new device shows the "Not me?" banner for 24 hours. */
export const NEW_DEVICE_SECS = 24 * 60 * 60;

/** The devices that signed in during the last 24 hours, other than this one, not yet signed out, and not already dismissed. */
export function newDevices(devices: AccountDevice[], nowSecs: number, dismissed: ReadonlySet<string>, ownId: string | null = null): AccountDevice[] {
  return devices.filter((d) => !d.is_this && d.id !== ownId && !d.revoked && !dismissed.has(d.id) && nowSecs - d.created_at < NEW_DEVICE_SECS && d.created_at <= nowSecs + 60);
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
