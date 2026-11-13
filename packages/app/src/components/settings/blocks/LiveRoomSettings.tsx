// Settings › General › Live Room: the relay address, the default length and viewers for a new room.
// The relay is checked by the app when saved (https for a remote host); its refusal is shown as is.
import { errorSentence } from '../../../lib/sayError';
import { useEffect, useState } from 'react';
import { useT } from '../../../i18n';
import { durationLabel, liveRoomApi, type LiveRoomApi, type LiveRoomConfig } from '../../../lib/live-room';
import { FieldInput, FieldSelect, Note, SettingRow } from '../settings-ui';

const MINUTES = [30, 60, 120, 240, 480];
const VIEWERS = [5, 10, 25, 50];

const errText = (err: unknown): string => (errorSentence(err));

export function LiveRoomSettings({
  api = liveRoomApi,
  teamRelay = '',
  onSaved,
}: {
  api?: LiveRoomApi;
  /** The team relay address when a team relay is set. Shown as the placeholder of the relay field. */
  teamRelay?: string;
  onSaved?: () => void;
}) {
  const t = useT();
  const [cfg, setCfg] = useState<LiveRoomConfig | null>(null);
  const [relay, setRelay] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .configGet()
      .then((c) => {
        if (!live) return;
        setCfg(c);
        setRelay(c.relay);
      })
      .catch((err) => live && setError(errText(err)));
    return () => {
      live = false;
    };
  }, [api]);

  if (!cfg) return error ? <Note role="alert">{error}</Note> : null;

  /** Saves the whole config. On a refusal the field keeps what the person typed and the reason shows. */
  const save = (next: LiveRoomConfig) => {
    setError(null);
    api
      .configSet(next)
      .then(() => {
        setCfg(next);
        onSaved?.();
      })
      .catch((err) => setError(errText(err)));
  };

  const saveRelay = () => {
    const next = relay.trim();
    if (next === cfg.relay) return;
    save({ ...cfg, relay: next });
  };

  return (
    <>
      <SettingRow label={t('teamPage.relayAddress')} description={t('liveRoom.relayHelp')}>
        <FieldInput
          aria-label={t('teamPage.relayAddress')}
          value={relay}
          placeholder={teamRelay.trim() ? t('liveRoom.usesTeam') : 'https://relay.example.com'} // i18n-ok: example
          onChange={(e) => setRelay(e.target.value)}
          onBlur={saveRelay}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveRelay();
          }}
          spellCheck={false}
        />
      </SettingRow>
      <SettingRow label={t('liveRoom.length')} description={t('liveRoom.lengthHelp')}>
        <FieldSelect
          aria-label={t('liveRoom.length')}
          value={String(cfg.minutes)}
          onChange={(e) => save({ ...cfg, relay: relay.trim(), minutes: Number(e.target.value) })}
        >
          {MINUTES.map((m) => (
            <option key={m} value={m}>
              {durationLabel(m)}
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      <SettingRow label={t('liveRoom.viewers')} description={t('liveRoom.viewersHelp')}>
        <FieldSelect
          aria-label={t('liveRoom.viewers')}
          value={String(cfg.maxViewers)}
          onChange={(e) => save({ ...cfg, relay: relay.trim(), maxViewers: Number(e.target.value) })}
        >
          {VIEWERS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </FieldSelect>
      </SettingRow>
      {error && <Note role="alert">{error}</Note>}
      <Note>{t('liveRoom.note')}</Note>
    </>
  );
}
