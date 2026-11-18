// The runtime of another PC: a client for its `/pclink/` routes, and a subscription to its live events. It is NOT the phone's
// bridge client (`lib/bridge.ts`): another PC is spoken to through the PC link's own routes and levels (`./pclink.ts`), and its
// events arrive as the PC link's own frames, as the Tauri event `device://event`.
//
// The far device enforces its rights. A refused call (403) comes back as an error whose text says so.
import type { DevicesApi } from '../devices';
import { makePcLinkClient, parsePcFrame, type PcEvent, type PcLinkClient } from './pclink';

/** A client for the device `node`: every call runs on its `/pclink/` routes. */
export function makeRemoteClient(node: string, api: Pick<DevicesApi, 'request'>): PcLinkClient {
  return makePcLinkClient(node, api);
}

/** One frame to the PC link's event it carries; null for a comment or noise. */
export const parseFrame = parsePcFrame;

type SubApi = Pick<DevicesApi, 'subscribe' | 'unsubscribe' | 'onEvent'>;

/** How many listeners each device's stream has: the command is sent on the first and undone on the last. */
const holders = new Map<string, number>();

/**
 * Subscribes to one device's live events. Returns the stop function. Events of other devices are ignored; the far
 * device only sends what its level for this PC allows. Several listeners share one stream (counted per device).
 */
export async function subscribeRemote(node: string, api: SubApi, onEvent: (e: PcEvent) => void): Promise<() => void> {
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
