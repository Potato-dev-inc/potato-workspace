import { useCallback, useEffect, useState } from 'react';
import { devicesApi, type Device, type DevicesApi, type DevicesView, type HostingView } from '../../lib/devices';

/** How often the state is read again when no change event came (a link going down is only noticed by asking). */
const REFRESH_MS = 15_000;

export interface DevicesHandle {
  /** Null until the first answer, or when the backend has no such command. */
  view: DevicesView | null;
  /** The Labs switch, as the backend reports it. Every devices screen draws nothing while it is false. */
  enabled: boolean;
  refresh: () => void;
}

/** A device from an older backend lacks the newer fields: they read as "nothing to say". */
function saneDevice(d: Device): Device {
  return {
    ...d,
    too_old: d.too_old === true,
    lets_files: d.lets_files === true,
    lets_web: d.lets_web === true,
    agents_may_send: d.agents_may_send === true,
    lets_lend: d.lets_lend === true,
    web_ready: d.web_ready === true,
    route_override: d.route_override ?? null,
    signed_out: Array.isArray(d.signed_out) ? d.signed_out.filter((x) => typeof x === 'string') : [],
    needs_person: Array.isArray(d.needs_person) ? d.needs_person.filter((n) => n && typeof n.what === 'string') : [],
    connected: d.connected === true,
    room: Array.isArray(d.room) ? d.room.filter((r) => r && typeof r.agent_id === 'string') : [],
    room_at: typeof d.room_at === 'number' ? d.room_at : null,
  };
}

function saneHosting(h: HostingView | null | undefined): HostingView | null {
  return h ? { ...h, kind: h.kind === 'link' ? 'link' : 'code' } : null;
}

/** A bad answer (an older backend, a mock that returns nothing) is no state at all. */
function sane(value: unknown): DevicesView | null {
  const v = value as Partial<DevicesView> | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.devices)) return null;
  return {
    enabled: v.enabled === true,
    name: v.name ?? '',
    route_pref: v.route_pref ?? 'auto',
    own_route_ready: v.own_route_ready === true,
    hosting: saneHosting(v.hosting),
    pending: v.pending ?? null,
    joining: v.joining ?? null,
    message: v.message ?? null,
    locked_until: v.locked_until ?? null,
    tampered: v.tampered === true,
    devices: v.devices.map(saneDevice),
    transfers: Array.isArray(v.transfers) ? v.transfers.filter((x) => x && typeof x.id === 'number') : [],
  };
}

/** The devices state, kept current: on `devices://changed` and every few seconds. */
export function useDevices(api: DevicesApi = devicesApi): DevicesHandle {
  const [view, setView] = useState<DevicesView | null>(null);
  const refresh = useCallback(() => {
    api
      .state()
      .then((s) => setView(sane(s)))
      .catch(() => setView(null));
  }, [api]);
  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    let disposed = false;
    api
      .onChanged((v) => setView(sane(v)))
      .then((u) => (disposed ? u() : (off = u)))
      .catch(() => {});
    const poll = window.setInterval(refresh, REFRESH_MS);
    return () => {
      disposed = true;
      off?.();
      window.clearInterval(poll);
    };
  }, [api, refresh]);
  return { view, enabled: view?.enabled === true, refresh };
}
