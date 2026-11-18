// "Open that device": Settings > Devices, on one device's own page. A lend screen that names a switch on
// this PC (Borrow my agent sign-ins, on one device) asks here, so the person lands on the switch itself
// instead of hunting for the device in a list. The Devices page takes the request when it mounts, or at
// once when it is already open. The other PC is never touched: only this PC's own pages open.
import { openSettingsAt } from './openSettingsAt';

const EVENT = 'pm:open-device';

let pending: string | null = null;

/** Opens Settings > Devices on `node`'s page. */
export function openDeviceAt(node: string): void {
  pending = node;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: { node } }));
  openSettingsAt('devices');
}

/** Shows `node`'s page in the Devices page that is already open (Connect > My PCs). Nothing else opens or moves. */
export function selectDevice(node: string): void {
  pending = node;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: { node } }));
}

/** The device the last call asked for, once (the Devices page takes it as it opens). */
export function takePendingDevice(): string | null {
  const node = pending;
  pending = null;
  return node;
}

/** A device asked for while the Devices page is already open. Returns the stop function. */
export function onOpenDevice(cb: (node: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const node = (e as CustomEvent<{ node?: unknown }>).detail?.node;
    if (typeof node === 'string' && node !== '') cb(node);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

const FOCUS_EVENT = 'pm:focus-device-group';

/** Connect > Devices > Open: unfold that PC's section of the sidebar and scroll to it. */
export function focusDeviceGroup(node: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { node } }));
}

/** A PC's section was asked for (Open on Connect). Returns the stop function. */
export function onFocusDeviceGroup(cb: (node: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const node = (e as CustomEvent<{ node?: unknown }>).detail?.node;
    if (typeof node === 'string' && node !== '') cb(node);
  };
  window.addEventListener(FOCUS_EVENT, handler);
  return () => window.removeEventListener(FOCUS_EVENT, handler);
}
