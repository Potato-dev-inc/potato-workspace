// "Room left" in the Usage card: one thin meter per sign-in, on this PC, on each paired PC and lent to this PC.
// Numbers only. A PC that does not answer shows its last known number and how old it is; a plan with no number says "unknown".
import { devicesApi, type DevicesApi } from '../../lib/devices';
import { placesOf, roomLine, type Place } from '../../lib/room';
import type { UsageRow } from '../../lib/usage';
import { formatLeftLong } from '../../lib/usage';
import { useT } from '../../i18n';
import { AgentLogo } from '../common/AgentLogo';
import { useDevices } from '../devices/useDevices';

function Meter({ place, now }: { place: Place; now: number }) {
  const t = useT();
  const pct = place.room.percent_left;
  const told = !place.online && place.told_at ? t('status.room.stale', { time: formatLeftLong(now - place.told_at * 1000) }) : '';
  return (
    <li className={`ck-room-row${place.online ? '' : ' is-stale'}`} data-testid="room-row" data-agent={place.room.agent_id} data-place={place.node ?? place.kind}>
      <AgentLogo id={place.room.agent_id} name={place.room.agent_label} size={14} decorative />
      <span className="ck-room-text">{roomLine(place, now)}</span>
      {pct !== null && (
        <span className="ck-room-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={roomLine(place, now)}>
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      {told && <span className="ck-room-stale">{told}</span>}
    </li>
  );
}

/** Drawn only when there is something besides this PC to compare with (a paired PC or a lent sign-in). */
export function RoomMeters({ rows, now, api = devicesApi }: { rows: UsageRow[]; now: number; api?: DevicesApi }) {
  const t = useT();
  const { view } = useDevices(api);
  const places = placesOf(rows, view?.enabled ? view : null);
  if (!places.some((p) => p.kind !== 'this')) return null;
  return (
    <section className="ck-room" data-testid="room-left" aria-label={t('status.room.title')}>
      <h3 className="ck-room-title">{t('status.room.title')}</h3>
      <ul className="ck-room-list">
        {places.map((p, i) => (
          <Meter key={`${p.kind}:${p.node ?? ''}:${p.room.agent_id}:${p.room.account_label ?? ''}:${i}`} place={p} now={now} />
        ))}
      </ul>
    </section>
  );
}
