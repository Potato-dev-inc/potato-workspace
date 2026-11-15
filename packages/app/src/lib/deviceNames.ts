// "Sent from": every message of the person records which device sent it, and the chat shows it quietly under the message
// ("from OPPO Reno13", "from Ren's Mac"). The names come from the one device identity record on the PC (Rust
// `device_identity`): a rename there shows in every chat, new and old. Pure code with no Tauri import (the phone uses it).
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { ChatTurn } from './sessionChatModel';

/** The id the PC gives itself. */
export const LOCAL_DEVICE = 'local';

export type DeviceNameMap = Record<string, { name: string; kind: string }>;
export type DeviceNamesLoader = () => Promise<DeviceNameMap>;

/** Fired (on `window`) when a device was renamed, so open chats read the names again. */
export const DEVICE_NAMES_CHANGED = 'pm-device-names-changed';

/** The name to show for a device id; `null` when this PC does not know it. */
export function deviceName(id: string | undefined | null, names: DeviceNameMap): string | null {
  return names[id || LOCAL_DEVICE]?.name ?? null;
}

/**
 * The quiet line under each message, by turn id. A message from this PC says nothing while every message came from this PC
 * (one device, nothing to tell apart); once another device wrote in the chat, every message says where it came from.
 */
export function sentFromLines(turns: readonly ChatTurn[], names: DeviceNameMap): Map<string, string> {
  const out = new Map<string, string>();
  const senders = new Set<string>();
  for (const turn of turns) if (turn.user) senders.add(turn.user.from || LOCAL_DEVICE);
  const mixed = senders.size > 1 || (senders.size === 1 && !senders.has(LOCAL_DEVICE));
  if (!mixed) return out;
  for (const turn of turns) {
    if (!turn.user) continue;
    const name = deviceName(turn.user.from, names);
    if (name) out.set(turn.id, t('sentFrom.from', { name }));
  }
  return out;
}

/** The device names, read once and again whenever a rename is announced. `{}` until they arrive (the line then stays off). */
export function useDeviceNames(load: DeviceNamesLoader | null): DeviceNameMap {
  const [names, setNames] = useState<DeviceNameMap>({});
  useEffect(() => {
    if (!load) return;
    let live = true;
    const read = () => {
      load()
        .then((next) => live && next && setNames(next))
        .catch(() => undefined);
    };
    read();
    window.addEventListener(DEVICE_NAMES_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(DEVICE_NAMES_CHANGED, read);
    };
  }, [load]);
  return names;
}
