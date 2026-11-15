import { describe, expect, it } from 'vitest';
import type { Device } from './devices';
import { mostRoom, placesOf, resetText, roomLine, roomOfUsage, suggestion, type RoomRow } from './room';
import type { UsageRow } from './usage';

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  agent_id: 'claude', label: 'Claude', account_id: null, account_label: null, state: 'ok', reason: null,
  windows: [{ name: '5-hour', used_percent: 38, minutes: 300, resets_at_ms: new Date(2026, 10, 16, 18, 0).getTime(), reset_since: false }],
  plan: null, observed_at_ms: NOW, limited_until_ms: null, page: null, ...over,
});
const far = (name: string, node: string, left: number | null, over: Partial<Device> = {}, reset: number | null = null): Device =>
  ({ node, name, state: 'online', room: [{ agent_id: 'claude', agent_label: 'Claude', account_label: null, percent_left: left, resets_at_ms: reset, observed_at_ms: 1 } satisfies RoomRow], room_at: 100, ...over }) as Device;

describe('room left', () => {
  it('reads the tightest window as percent left; a limit is 0; no number is unknown', () => {
    expect(roomOfUsage(row()).percent_left).toBe(62);
    expect(roomOfUsage(row({ windows: [{ name: 'a', used_percent: 10, resets_at_ms: 1, reset_since: false }, { name: 'b', used_percent: 90, resets_at_ms: 2, reset_since: false }] })).percent_left).toBe(10);
    expect(roomOfUsage(row({ state: 'limited', limited_until_ms: 5 }))).toMatchObject({ percent_left: 0, resets_at_ms: 5 });
    expect(roomOfUsage(row({ state: 'unknown', windows: [] })).percent_left).toBeNull();
    expect(roomOfUsage(row({ state: 'expired' })).percent_left).toBeNull();
  });

  it('says it in one line, and "unknown" instead of a guess', () => {
    const [mine] = placesOf([row()], null);
    expect(roomLine(mine!, NOW)).toBe('Claude on this PC: 62% left, resets 18:00');
    const unknown = placesOf([row({ state: 'unknown', windows: [] })], null)[0]!;
    expect(roomLine(unknown, NOW)).toBe('Claude on this PC: unknown');
    expect(resetText(new Date(2026, 10, 17, 9, 5).getTime(), NOW)).toMatch(/09:05$/);
  });

  it('picks the online place with the most room; offline, unknown and lent ones are never picked', () => {
    const places = placesOf([row({ windows: [{ name: 'w', used_percent: 80, reset_since: false }] })], { devices: [far('Laptop', 'n1', 70), far('Mac', 'n2', 95, { state: 'offline' }), far('Desk', 'n3', null)] });
    expect(mostRoom(places, 'claude')?.name).toBe('Laptop');
    expect(mostRoom(places, 'codex')).toBeNull();
    const lent = placesOf([row({ link: 'borrowed', account_label: 'Lent account' }), row({ windows: [{ name: 'w', used_percent: 90, reset_since: false }] })], null);
    expect(lent.map((p) => p.kind)).toEqual(['this', 'lent']);
    expect(mostRoom(lent, 'claude')?.kind).toBe('this');
  });

  it('a tie goes to the earlier reset, then to this PC', () => {
    const places = placesOf([row({ windows: [{ name: 'w', used_percent: 40, resets_at_ms: 900, reset_since: false }] })], { devices: [far('Laptop', 'n1', 60, {}, 100)] });
    expect(mostRoom(places, 'claude')?.name).toBe('Laptop');
    const tie = placesOf([row({ windows: [{ name: 'w', used_percent: 40, reset_since: false }] })], { devices: [far('Laptop', 'n1', 60)] });
    expect(mostRoom(tie, 'claude')?.kind).toBe('this');
  });

  it('suggests another PC only when this PC is short and the other has clearly more', () => {
    const short = row({ windows: [{ name: 'w', used_percent: 80, reset_since: false }] });
    expect(suggestion(placesOf([short], { devices: [far('Laptop', 'n1', 70)] }))?.name).toBe('Laptop');
    expect(suggestion(placesOf([short], { devices: [far('Laptop', 'n1', 30)] }))).toBeNull();
    expect(suggestion(placesOf([row()], { devices: [far('Laptop', 'n1', 99)] }))).toBeNull();
    expect(suggestion(placesOf([short], { devices: [far('Laptop', 'n1', 99, { state: 'offline' })] }))).toBeNull();
  });
});
