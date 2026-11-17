// "Sent from": every message of the person records which device sent it, and the chat shows it quietly under the message
// ("from OPPO Reno13", "from Ren's Mac"). The names come from the one device identity record on the PC (Rust
// `device_identity`): a rename there shows in every chat, new and old. Pure code with no Tauri import (the phone uses it).
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { ChatTurn } from './sessionChatModel';

/** The id the PC gives itself. */
export const LOCAL_DEVICE = 'local';

/** Senders that are the app itself, not a device of the person (an older chat may hold such a message): a helper's result that
 * the app hands to the agent that asked for it. */
export const APP_SENDER_PREFIX = 'app:';
export const isAppSender = (from: string | undefined | null): boolean => !!from && from.startsWith(APP_SENDER_PREFIX);
/** The app's notice that a task was handed to this agent, or from it to another (Rust `handover`). */
export const APP_HANDOVER_SENDER = 'app:handover';

/** Notes between an agent and the agent it spun off (Rust `acp/chat/spin_off.rs`): `parent:<name>` is the agent that spun this chat
 * off, writing in it; `spinoff:<name>` is a spin-off writing to this chat. Neither is a device of the person. */
export const FROM_PARENT_PREFIX = 'parent:';
export const FROM_SPIN_OFF_PREFIX = 'spinoff:';
const agentNote = (from: string | undefined | null): { name: string; kind: 'parent' | 'spinOff' } | null => {
  if (!from) return null;
  if (from.startsWith(FROM_PARENT_PREFIX)) return { name: from.slice(FROM_PARENT_PREFIX.length), kind: 'parent' };
  if (from.startsWith(FROM_SPIN_OFF_PREFIX)) return { name: from.slice(FROM_SPIN_OFF_PREFIX.length), kind: 'spinOff' };
  return null;
};
/** Not the person's own words: the app wrote it, or another agent did. */
export const isAgentSender = (from: string | undefined | null): boolean => isAppSender(from) || agentNote(from) !== null;

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
  // A message the app wrote always says so, and is never counted as a device of the person.
  for (const turn of turns) if (turn.user && isAppSender(turn.user.from)) out.set(turn.id, t(turn.user.from === APP_HANDOVER_SENDER ? 'sentFrom.handover' : 'sentFrom.app'));
  // A note from another agent says whose it is, and is not counted as a device either.
  for (const turn of turns) {
    const note = turn.user ? agentNote(turn.user.from) : null;
    if (note) out.set(turn.id, t(note.kind === 'parent' ? 'sentFrom.parent' : 'sentFrom.spinOff', { name: note.name }));
  }
  for (const turn of turns) if (turn.user && !isAgentSender(turn.user.from)) senders.add(turn.user.from || LOCAL_DEVICE);
  const mixed = senders.size > 1 || (senders.size === 1 && !senders.has(LOCAL_DEVICE));
  if (!mixed) return out;
  for (const turn of turns) {
    if (!turn.user || isAgentSender(turn.user.from)) continue;
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
