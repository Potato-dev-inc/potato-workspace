// A bridge client for another device. It is the same `BridgeClient` the phone uses (so the phone's chat view and every
// typed call work unchanged); only the transport differs: a call goes through `devices_request` (the PC link) instead
// of `fetch`, and the live events arrive as the Tauri event `device://event` instead of an event stream.
//
// The far device enforces its rights. A refused call (403 `not_allowed`) comes back as an error whose text says so.
import type { BridgeClient, BridgeEvent } from '../bridge-types';
import { dispatchBridgeEvent } from '../bridge-sse';
import { makeBridgeClient, type BridgeTransport } from '../bridge';
import type { DevicesApi } from '../devices';

/** The transport of one device. */
export function deviceTransport(node: string, api: Pick<DevicesApi, 'request'>): BridgeTransport {
  return async (method, path, body) => {
    const res = await api.request(node, method, path, body);
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return { status: res.status, text };
  };
}

/** A `BridgeClient` whose calls run on the device `node`. */
export function makeRemoteClient(node: string, api: Pick<DevicesApi, 'request'>): BridgeClient {
  return makeBridgeClient(`device:${node}`, deviceTransport(node, api));
}

/** One SSE frame (`event: x\ndata: {...}\n\n`) to the typed bridge event it carries; null for a comment or noise. */
export function parseFrame(frame: string): BridgeEvent | null {
  let name = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  let out: BridgeEvent | null = null;
  try {
    dispatchBridgeEvent(name, data, (e) => {
      out = e;
    });
  } catch {
    return null;
  }
  return out;
}

type SubApi = Pick<DevicesApi, 'subscribe' | 'unsubscribe' | 'onEvent'>;

/** How many listeners each device's stream has: the command is sent on the first and undone on the last. */
const holders = new Map<string, number>();

/**
 * Subscribes to one device's live events. Returns the stop function. Events of other devices are ignored; the far
 * device only sends what its level for this PC allows. Several listeners share one stream (counted per device).
 */
export async function subscribeRemote(node: string, api: SubApi, onEvent: (e: BridgeEvent) => void): Promise<() => void> {
  const stopListen = await api.onEvent((ev) => {
    if (ev.node !== node) return;
    const parsed = parseFrame(ev.frame);
    if (parsed) onEvent(parsed);
  });
  const before = holders.get(node) ?? 0;
  holders.set(node, before + 1);
  if (before === 0) {
    try {
      await api.subscribe(node);
    } catch (error) {
      holders.set(node, before);
      stopListen();
      throw error;
    }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopListen();
    const left = (holders.get(node) ?? 1) - 1;
    if (left <= 0) {
      holders.delete(node);
      void api.unsubscribe(node).catch(() => undefined);
    } else holders.set(node, left);
  };
}
