// "Room left": how much of each plan is left, per sign-in, on this PC, on the other paired PCs and lent to this PC.
// Only numbers and labels exist here (percent left, reset time, account label): the other PC's numbers arrive in the
// device list (`Device.room`, Rust `usage/room.rs`); no login or token ever does.
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Device, DevicesView } from './devices';
import { usageApi, type UsageApi, type UsageRow } from './usage';

export interface RoomRow {
  agent_id: string;
  agent_label: string;
  account_label: string | null;
  /** 0-100; null when the plan did not say ("unknown", never a guess). */
  percent_left: number | null;
  resets_at_ms: number | null;
  observed_at_ms: number | null;
}

export type RoomKind = 'this' | 'device' | 'lent';

export interface Place {
  kind: RoomKind;
  /** The device node; null for this PC and for what is lent. */
  node: string | null;
  name: string;
  /** Whether the numbers are live (this PC, lent, or a device that answers). */
  online: boolean;
  /** When a device last told its numbers (unix seconds). */
  told_at: number | null;
  room: RoomRow;
}

/** One usage row as a room row: the tightest window's percent left; a limit is 0; no window is unknown. */
export function roomOfUsage(row: UsageRow): RoomRow {
  const open = row.windows.filter((w) => !w.reset_since);
  const tight = open.reduce<UsageRow['windows'][number] | null>((best, w) => (!best || w.used_percent > best.used_percent ? w : best), null);
  let left: number | null = null;
  let resets: number | null = null;
  if (row.state === 'limited') {
    left = 0;
    resets = row.limited_until_ms ?? tight?.resets_at_ms ?? null;
  } else if (row.state === 'ok') {
    if (tight) {
      left = Math.round(Math.max(0, Math.min(100, 100 - tight.used_percent)));
      resets = tight.resets_at_ms ?? null;
    } else if (row.windows.length > 0) left = 100;
  }
  return { agent_id: row.agent_id, agent_label: row.label, account_label: row.account_label, percent_left: left, resets_at_ms: resets, observed_at_ms: row.observed_at_ms };
}

/** Every place that has a sign-in: this PC first, then lent to this PC, then each paired PC. Pay-per-use rows have no limit and are left out. */
export function placesOf(rows: UsageRow[], view: Pick<DevicesView, 'devices'> | null): Place[] {
  const own = rows.filter((r) => r.link !== 'borrowed' && !r.totals).map((r): Place => ({ kind: 'this', node: null, name: t('status.room.thisPc'), online: true, told_at: null, room: roomOfUsage(r) }));
  const lent = rows.filter((r) => r.link === 'borrowed').map((r): Place => ({ kind: 'lent', node: null, name: r.account_label ?? r.label, online: true, told_at: null, room: roomOfUsage(r) }));
  const far = (view?.devices ?? []).flatMap((d: Device): Place[] =>
    (Array.isArray(d.room) ? d.room : []).map((room) => ({ kind: 'device', node: d.node, name: d.name, online: d.state === 'online', told_at: d.room_at ?? null, room })),
  );
  return [...own, ...lent, ...far];
}

/** The place with the most room for an agent: online, known percent, most left; earlier reset wins a tie, then this PC. */
export function mostRoom(places: Place[], agentId: string): Place | null {
  let best: Place | null = null;
  for (const p of places) {
    if (!p.online || p.kind === 'lent' || p.room.agent_id !== agentId || p.room.percent_left === null) continue;
    if (!best) {
      best = p;
      continue;
    }
    const a = p.room.percent_left;
    const b = best.room.percent_left as number;
    const ra = p.room.resets_at_ms ?? Number.MAX_SAFE_INTEGER;
    const rb = best.room.resets_at_ms ?? Number.MAX_SAFE_INTEGER;
    if (a > b || (a === b && ra < rb) || (a === b && ra === rb && p.kind === 'this' && best.kind !== 'this')) best = p;
  }
  return best;
}

/** A device is worth suggesting when it has this much more room than this PC. */
const BETTER_BY = 20;
/** This PC is only "short" at or under this much left. */
const SHORT_AT = 50;

/** The one-line suggestion for New agent: a paired PC with clearly more room for an agent this PC is short of. */
export function suggestion(places: Place[]): Place | null {
  const agents = [...new Set(places.filter((p) => p.kind === 'this').map((p) => p.room.agent_id))];
  let pick: Place | null = null;
  let gain = 0;
  for (const id of agents) {
    const here = mostRoom(places.filter((p) => p.kind === 'this'), id);
    if (!here || (here.room.percent_left as number) > SHORT_AT) continue;
    const best = mostRoom(places, id);
    if (!best || best.kind !== 'device' || best.node === null) continue;
    const g = (best.room.percent_left as number) - (here.room.percent_left as number);
    if (g >= BETTER_BY && g > gain) {
      pick = best;
      gain = g;
    }
  }
  return pick;
}

/** "18:00" today, "Tue 18:00" another day. */
export function resetText(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "Claude on this PC: 62% left, resets 18:00". */
export function roomLine(p: Place, now: number): string {
  const agent = p.room.account_label && p.kind !== 'lent' ? `${p.room.agent_label} (${p.room.account_label})` : p.room.agent_label;
  if (p.room.percent_left === null) return t('status.room.unknown', { agent, place: p.name });
  if (p.kind === 'lent') return t('status.room.lent', { agent, pct: p.room.percent_left });
  return p.room.resets_at_ms ? t('status.room.line', { agent, place: p.name, pct: p.room.percent_left, when: resetText(p.room.resets_at_ms, now) }) : t('status.room.lineNoReset', { agent, place: p.name, pct: p.room.percent_left });
}

/** This PC's usage rows and the paired PCs' numbers, read once when `on` turns true. Never throws. */
export function useRoomPlaces(on: boolean, view: DevicesView | null, api: UsageApi = usageApi): Place[] {
  const [rows, setRows] = useState<UsageRow[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.snapshot(false, true).then(
      (s) => live && setRows(Array.isArray(s?.rows) ? s.rows : []),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [on, api]);
  return placesOf(rows, view);
}
