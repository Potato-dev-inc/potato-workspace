// "How far-away devices connect": one choice for this PC. Devices on the same network always connect directly.
import { useT } from '../../i18n';
import type { RoutePref } from '../../lib/devices';

export function RouteSetting({ value, onChange, ownReady = true }: { value: RoutePref; onChange: (pref: RoutePref) => void; ownReady?: boolean }) {
  const t = useT();
  const options: { id: RoutePref; label: string; help: string }[] = [
    { id: 'auto', label: t('devices.route.auto'), help: t('devices.route.autoHelp') },
    { id: 'public', label: t('devices.route.public'), help: t('devices.route.publicHelp') },
    { id: 'own', label: t('devices.route.own'), help: t('devices.route.ownHelp') },
  ];
  return (
    <fieldset className="dev-route" data-testid="route-setting">
      <legend>{t('devices.route.title')}</legend>
      <p className="dev-note">{t('devices.route.hint')}</p>
      {options.map((o) => (
        <label key={o.id} className="dev-opt">
          <input type="radio" name="dev-route" checked={value === o.id} onChange={() => onChange(o.id)} data-testid={`route-${o.id}`} />
          <span>
            <b>{o.label}</b>
            <small>{o.help}</small>
          </span>
        </label>
      ))}
      {value === 'own' && !ownReady && <p className="dev-note" data-testid="route-own-setup">{t('devices.route.ownSetup')}</p>}
    </fieldset>
  );
}
